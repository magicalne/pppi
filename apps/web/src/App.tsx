import type {
	AgentState,
	AgentStatus,
	Artifact,
	ChatEntry,
	ModelInfo,
	Profile,
	ServerEvent,
	SessionsResponse,
	TaskUpdate,
} from "@pppi/protocol";
import type { Attachment } from "@pppi/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArtifactCard, useArtifactViewer } from "./Artifact.tsx";
import { AttachmentChips } from "./Attachments.tsx";
import { PeerReportToast } from "./PeerReportToast.tsx";
import { OMNI, SessionDrawer, type Target } from "./SessionDrawer.tsx";
import { TaskCard, liveTask } from "./Task.tsx";
import { copyTextToClipboard } from "./copy.ts";
import { DEMO_ARTIFACT } from "./demoArtifact.ts";
import { Markdown } from "./markdown.tsx";
import { messageToPlainText } from "./plainText.ts";
import { ReconnectController, type ReconnectState, mergeResume } from "./reconnect.ts";
import { StatusBar } from "./status/StatusBar.tsx";
import { THEMES, type ThemeId, applyTheme, loadTheme } from "./theme.ts";
import { VoiceWave } from "./voice/VoiceWave.tsx";
import { useVoice } from "./voice/useVoice.ts";
import { useWakeLock } from "./wakeLock.ts";

type Pairing = { server: string; token: string };

/** One paired machine (gateway + its omni). Clients hold only the token. */
type Connection = { id: string; name: string; url: string; token: string; color?: string };

type Msg = {
	id: string;
	role: "user" | "assistant";
	text: string;
	source?: "voice" | "text";
	target?: string;
	profileId?: string;
	tool?: { phase: "start" | "end"; label?: string };
	/** artifacts extracted from this reply by the gateway (#17) */
	artifacts?: Artifact[];
	/** uploads riding this message (#upload) */
	attachments?: Attachment[];
	/** task fences extracted from this reply (#15) — entry-time snapshots */
	tasks?: TaskUpdate[];
	/** ms epoch, set on history entries — anchors older-page loads */
	ts?: number;
};

/** the recent window cached on the client; older pages load only on demand (scroll to top) */
const HISTORY_PAGE = 50;

// sspi → pppi rename: carry pre-rename localStorage keys (pairing, theme) across
for (let i = localStorage.length - 1; i >= 0; i--) {
	const key = localStorage.key(i);
	if (!key?.startsWith("sspi.")) continue;
	const next = `pppi.${key.slice(5)}`;
	if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key) ?? "");
	localStorage.removeItem(key);
}

function loadConnections(): Connection[] {
	try {
		const raw = localStorage.getItem("pppi.connections");
		if (raw) {
			const list = JSON.parse(raw) as Connection[];
			if (Array.isArray(list) && list.length) return list;
		}
	} catch {
		// ignore
	}
	// migrate the v0 single-pairing record
	try {
		const raw = localStorage.getItem("pppi.pairing");
		if (raw) {
			const p = JSON.parse(raw) as Pairing;
			if (p.server && p.token) {
				return [{ id: p.server, name: hostOf(p.server), url: p.server, token: p.token }];
			}
		}
	} catch {
		// ignore
	}
	return [];
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Accepts a full pair link ("http://ip:port/?pair=token") or a bare server URL. */
function parsePairInput(input: string, tokenFallback: string): { url: string; token: string } | null {
	const s = input.trim().replace(/\/$/, "");
	if (!s) return null;
	const m = s.match(/^(https?:\/\/[^\s?]+)\/?\?pair=([A-Za-z0-9]+)$/);
	if (m) return { url: m[1]!, token: m[2]! };
	if (!/^https?:\/\//.test(s)) return null;
	const token = tokenFallback.trim();
	return token ? { url: s, token } : null;
}

/** PRD §5 grammar — the omni session's one-line status. */
function omniStatus(
	state: AgentState,
	toolLabel: string | null,
	connected: boolean,
	reconnect: ReconnectState = "connecting",
): string {
	if (!connected) return reconnect === "reconnecting" ? "reconnecting…" : "connecting…";
	switch (state) {
		case "thinking":
			return "thinking…";
		case "tool":
			return `${toolLabel ?? "working"}…`;
		case "streaming":
			return "typing…";
		case "compacting":
			return "compacting…";
		case "waiting":
			return "needs you…";
		case "starting":
			return "waking up…";
		default:
			return "";
	}
}

export default function App() {
	const [theme, setTheme] = useState<ThemeId>(loadTheme);
	const [tab, setTab] = useState<"chat" | "themes">("chat");
	const [connections, setConnections] = useState<Connection[]>(loadConnections);
	const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem("pppi.active"));
	const [connected, setConnected] = useState(false);
	/** issue #22: chat-socket reconnect policy state — feeds the status line */
	const [reconn, setReconn] = useState<ReconnectState>("connecting");
	const [msgs, setMsgs] = useState<Msg[]>([]);
	const [agentState, setAgentState] = useState<AgentState>("starting");
	const [toolLabel, setToolLabel] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	/** another screen is in an interactive voice session (gateway broadcasts voice_active) */
	const [voiceElsewhere, setVoiceElsewhere] = useState(false);
	const [target, setTarget] = useState<Target>(OMNI);
	const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
	const [modelList, setModelList] = useState<ModelInfo[]>([]);
	const [drawerOpen, setDrawerOpen] = useState(false);
	/** issue #17: full-screen artifact viewer (cards in the chat open this) */
	const artifactViewer = useArtifactViewer();
	/** #15: live task registry — latest status per id (task events / hello seed) */
	const [liveTasks, setLiveTasks] = useState<Record<string, TaskUpdate>>({});
	/** #13: a delegated reply landed while idle — tappable notification */
	const [peerReport, setPeerReport] = useState<{ id: string; profileId: string; preview: string } | null>(null);
	const [connOpen, setConnOpen] = useState(false);
	const [sessions, setSessions] = useState<SessionsResponse | null>(null);
	const [textInput, setTextInput] = useState("");
	// #upload: picked files awaiting the next text send (voice note: they
	// ride the NEXT text turn — speech alone can't carry them)
	const [pendingFiles, setPendingFiles] = useState<Array<{ id: string; file: File; url: string }>>([]);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [hasMoreHistory, setHasMoreHistory] = useState(false);
	const [serverVersion, setServerVersion] = useState("");
	const wsRef = useRef<WebSocket | null>(null);
	/** mirrors of live state for non-React callbacks (ws handlers, drop snapshots) */
	const msgsRef = useRef<Msg[]>([]);
	msgsRef.current = msgs;
	const agentStateRef = useRef<AgentState>("starting");
	agentStateRef.current = agentState;
	/** issue #22: last assistant text seen before a drop — compared after resume
	 * to say "last reply may be incomplete" honestly (a reply that completed
	 * server-side while we were away arrives longer; one still working isn't) */
	const resumeCheckRef = useRef<{ id: string; text: string } | null>(null);
	/** the active chat-socket reconnect controller (issue #22) */
	const reconnCtlRef = useRef<ReconnectController | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	/** guards one in-flight older-page load at a time */
	const loadingOlderRef = useRef(false);
	/** set when prepending a history page so the scroll effect restores position instead of jumping to bottom */
	const prependScrollRef = useRef<{ height: number; top: number } | null>(null);
	const voice = useVoice();
	// issue #18: keep the screen awake while the conversation is live — voice on,
	// voice booting, or an omni/delegated stream visibly working. The optional
	// "Keep screen on" toggle (Appearance page) forces it on regardless.
	const wakeActive =
		(!target.id && (agentState === "thinking" || agentState === "tool" || agentState === "streaming")) ||
		(target.id ? peerStatus(sessions, target.id) === "working…" : false) ||
		voice.on ||
		voice.state.boot !== null;
	const wake = useWakeLock(wakeActive);

	const conn = connections.find((c) => c.id === activeId) ?? connections[0] ?? null;

	useEffect(() => applyTheme(theme), [theme]);

	useEffect(() => {
		localStorage.setItem("pppi.connections", JSON.stringify(connections));
		if (connections.length) localStorage.removeItem("pppi.pairing"); // v0 key
	}, [connections]);

	useEffect(() => {
		if (activeId) localStorage.setItem("pppi.active", activeId);
	}, [activeId]);

	// ?pair=<token> onboarding: opening the gateway's pair link pairs this browser.
	// ?server=<url> supports static-hosted clients (GitHub Pages) whose origin is
	// NOT the gateway: ?server=http%3A%2F%2Fmac%3A8787&pair=<token>
	// issue #17 one-tap QA: open the client with ?demo-artifact and a local
	// demo message (card + sandboxed viewer) appears — no agent round-trip
	useEffect(() => {
		if (!new URLSearchParams(location.search).has("demo-artifact")) return;
		setMsgs((b) => [
			...b,
			{ id: "demo-artifact", role: "assistant", text: "Here's the demo artifact:", artifacts: [DEMO_ARTIFACT] },
		]);
	}, []);

	useEffect(() => {
		const params = new URLSearchParams(location.search);
		const token = params.get("pair");
		if (!token) return;
		const url = params.get("server") ?? location.origin;
		setConnections((prev) => {
			const next = [...prev.filter((c) => c.id !== url), { id: url, name: hostOf(url), url, token }];
			return next;
		});
		setActiveId(url);
		history.replaceState(null, "", location.pathname);
	}, []);

	const showNotice = useCallback((message: string) => {
		setNotice(message);
		setTimeout(() => setNotice((cur) => (cur === message ? null : cur)), 6000);
	}, []);

	function addConnection(c: Connection) {
		setConnections((prev) => [...prev.filter((x) => x.id !== c.id), c]);
		setActiveId(c.id);
	}

	function removeConnection(id: string) {
		setConnections((prev) => prev.filter((c) => c.id !== id));
		setActiveId((cur) => (cur === id ? null : cur));
	}

	// -------------------------------------------------------------- websocket

	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnect only on connection change; handlers close over current state
	useEffect(() => {
		if (!conn) return;
		const wsUrl = `${conn.url.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
		let closed = false;
		const connect = () => {
			if (closed) return;
			const ws = new WebSocket(wsUrl);
			wsRef.current = ws;
			ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: conn.token, client: "web" }));
			ws.onmessage = (m) => handleEvent(JSON.parse(m.data) as ServerEvent);
			ws.onclose = () => {
				setConnected(false);
				if (closed) return;
				// issue #22: snapshot the last assistant text — after resume, an
				// unchanged partial means the drop cut that reply off
				const last = [...msgsRef.current].reverse().find((x) => x.role === "assistant" && !x.tool);
				resumeCheckRef.current = last ? { id: last.id, text: last.text } : null;
				rc.onDrop();
			};
		};
		// issue #22: exponential backoff instead of a fixed 2s drum, plus an
		// immediate retry on visibilitychange→visible (the phone-unlock case:
		// frozen timers left the schedule stale, never wait out a backoff for it)
		const rc = new ReconnectController({ onStateChange: setReconn, onRetry: connect });
		reconnCtlRef.current = rc;
		const onVisible = () => {
			if (document.visibilityState === "visible") rc.onVisible();
		};
		document.addEventListener("visibilitychange", onVisible);
		connect();
		return () => {
			closed = true;
			rc.cancel();
			reconnCtlRef.current = null;
			document.removeEventListener("visibilitychange", onVisible);
			wsRef.current?.close();
			wsRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [conn?.id, conn?.token]);

	// learn the machine's name + omni profile color once connected
	const learnAbout = useCallback(async (c: Connection) => {
		try {
			const res = await fetch(`${c.url.replace(/\/$/, "")}/api/pair`, {
				headers: { authorization: `Bearer ${c.token}` },
			});
			if (res.ok) {
				const body = await res.json();
				if (body.ok && body.machine) {
					setConnections((prev) => prev.map((x) => (x.id === c.id ? { ...x, name: body.machine as string } : x)));
				}
			}
		} catch {
			// offline — keep the host name
		}
		// which build is the gateway running? (machines drawer; catches a stale install:ext)
		try {
			const health = await fetch(`${c.url.replace(/\/$/, "")}/api/health`).then((r) => r.json());
			const v = (health as { gateway?: { version?: string } })?.gateway?.version;
			if (v) setServerVersion(String(v));
		} catch {
			// best-effort
		}
	}, []);

	function handleEvent(evt: ServerEvent) {
		switch (evt.type) {
			case "hello_ok": {
				if (evt.tasks) setLiveTasks(Object.fromEntries(evt.tasks.map((t) => [t.id, t])));
				setConnected(true);
				setAgentState(evt.agent.state);
				// idempotent resume (#22): server history replaces by id — a reply
				// that finished while we were away lands complete, nothing dups
				const historyMsgs = evt.history.map((h: ChatEntry) => ({ ...h }) as Msg);
				setMsgs(mergeResume(msgsRef.current, historyMsgs));
				setHasMoreHistory(evt.history.length >= HISTORY_PAGE);
				// the drop cut a reply off if its last partial is unchanged and the
				// agent went idle — the socket (and #26's TTS abort) ended it
				const check = resumeCheckRef.current;
				resumeCheckRef.current = null;
				if (check && !["thinking", "tool", "streaming"].includes(evt.agent.state)) {
					const after = mergeResume(msgsRef.current, historyMsgs).find((x) => x.id === check.id);
					if (after && after.text === check.text && after.text !== "")
						showNotice("reconnected — last reply may be incomplete");
				}
				reconnCtlRef.current?.onSuccess();
				if (conn) void learnAbout(conn);
				break;
			}
			case "hello_fail":
				showNotice(evt.error);
				if (conn) removeConnection(conn.id);
				break;
			case "transcript":
				setMsgs((b) => [
					...b.filter((x) => x.id !== evt.id),
					{ id: evt.id, role: "user", text: evt.text, source: "voice", target: evt.target },
				]);
				break;
			case "user_message":
				setMsgs((b) =>
					b.some((x) => x.id === evt.id)
						? b
						: [...b, { id: evt.id, role: "user", text: evt.text, source: evt.source, target: evt.target }],
				);
				break;
			case "assistant_delta":
				setMsgs((b) => {
					const last = b.at(-1);
					if (last && last.role === "assistant" && last.id === evt.id) {
						return [...b.slice(0, -1), { ...last, text: last.text + evt.delta }];
					}
					return [
						...b,
						{ id: evt.id, role: "assistant", text: evt.delta, target: evt.target, profileId: evt.profileId },
					];
				});
				break;
			case "assistant_final":
				setMsgs((b) => {
					const idx = b.findIndex((x) => x.id === evt.id);
					const patch = (m: Msg): Msg => ({ ...m, text: evt.text, profileId: evt.profileId, artifacts: evt.artifacts });
					if (idx >= 0) {
						const copy = [...b];
						copy[idx] = patch(copy[idx]!);
						return copy;
					}
					return [
						...b,
						{
							id: evt.id,
							role: "assistant",
							text: evt.text,
							target: evt.target,
							profileId: evt.profileId,
							artifacts: evt.artifacts,
						},
					];
				});
				break;
			case "tool_event":
				if (evt.phase === "start") {
					setAgentState("tool");
					setToolLabel(evt.label ?? evt.toolName);
					setMsgs((b) => [
						...b.slice(-40),
						{
							id: `tool-${evt.toolName}-${Date.now()}`,
							role: "assistant",
							text: "",
							tool: { phase: "start", label: evt.label },
						},
					]);
				} else {
					setToolLabel(null);
				}
				break;
			case "agent_state":
				setAgentState(evt.state);
				if (evt.state !== "tool") setToolLabel(null);
				break;
			case "agent_notify":
				showNotice(evt.message);
				break;
			case "history_page": {
				const older = evt.entries.map((h: ChatEntry) => ({ ...h }));
				loadingOlderRef.current = false;
				if (older.length === 0) {
					setHasMoreHistory(false);
					break;
				}
				// keep the viewport anchored on the current top message
				const el = listRef.current;
				if (el) prependScrollRef.current = { height: el.scrollHeight, top: el.scrollTop };
				setMsgs((b) => [...older, ...b]);
				setHasMoreHistory(evt.hasMore);
				break;
			}
			case "status":
				setAgentStatus(evt.status);
				break;
			case "model_list":
				setModelList(evt.models);
				break;
			case "session_new":
				setMsgs([]);
				setHasMoreHistory(false);
				showNotice("started a fresh session");
				break;
			case "error":
				showNotice(evt.message);
				loadingOlderRef.current = false; // a failed history page must not wedge the guard
				break;
			case "voice_active":
				setVoiceElsewhere(evt.active);
				break;
			case "task":
				// #15: live status transition — cards flip in place
				setLiveTasks((t) => ({ ...t, [evt.task.id]: evt.task }));
				break;
			case "peer_report":
				// #13: background work finished — surface it, don't let it drown in chat
				setPeerReport({ id: evt.id, profileId: evt.profileId, preview: evt.preview });
				break;
		}
	}

	// -------------------------------------------------------------- sessions poll

	const refreshSessions = useCallback(async () => {
		if (!conn) return;
		try {
			const res = await fetch(`${conn.url.replace(/\/$/, "")}/api/sessions`, {
				headers: { authorization: `Bearer ${conn.token}` },
			});
			if (res.ok) {
				const data = (await res.json()) as SessionsResponse;
				setSessions(data);
				// tint the active connection with the omni profile color
				const omniProfile = data.profiles?.[data.omniSessionId];
				if (omniProfile) {
					setConnections((prev) => prev.map((x) => (x.id === conn.id ? { ...x, color: omniProfile.color } : x)));
				}
			}
		} catch {
			// ignore — drawer shows stale data
		}
	}, [conn]);

	// light always-on poll: bubble colors need the profiles map even with the drawer closed
	useEffect(() => {
		if (!conn || !connected) return;
		refreshSessions();
		const t = setInterval(refreshSessions, 20_000);
		return () => clearInterval(t);
	}, [conn, connected, refreshSessions]);

	// fast poll while the target tree is open
	useEffect(() => {
		if (!drawerOpen) return;
		refreshSessions();
		const t = setInterval(refreshSessions, 5000);
		return () => clearInterval(t);
	}, [drawerOpen, refreshSessions]);

	// -------------------------------------------------------------- actions

	const sendText = useCallback(() => {
		const text = textInput.trim();
		if ((!text && pendingFiles.length === 0) || !wsRef.current) return;
		if (pendingFiles.length === 0) {
			wsRef.current.send(JSON.stringify({ type: "chat", text, target: target.id }));
			setTextInput("");
			return;
		}
		// upload the picked files, then send text + refs in one chat message
		const sid = conn?.id ?? "web";
		void (async () => {
			const uploaded: Attachment[] = [];
			for (const f of pendingFiles) {
				const res = await fetch(
					`${conn?.url ?? ""}/api/upload?sid=${encodeURIComponent(sid)}&name=${encodeURIComponent(f.file.name)}`,
					{
						method: "POST",
						headers: { authorization: `Bearer ${conn?.token ?? ""}` },
						body: f.file,
					},
				).catch(() => null);
				if (!res?.ok) {
					showNotice(`couldn't upload ${f.file.name}`);
					return; // keep every chip; nothing half-sent
				}
				const body = (await res.json()) as { attachment: Attachment };
				uploaded.push(body.attachment);
			}
			wsRef.current?.send(JSON.stringify({ type: "chat", text, target: target.id, attachments: uploaded }));
			for (const f of pendingFiles) URL.revokeObjectURL(f.url);
			setPendingFiles([]);
			setTextInput("");
		})();
	}, [textInput, target, pendingFiles, conn, showNotice]);

	const toggleVoice = useCallback(() => {
		if (!conn) return;
		if (voice.on || voice.state.boot) {
			// the button always means stop/hang up — even mid-boot it cancels.
			// userInitiated (#22): the user ended the mic session — no auto-resume on unlock
			void voice.stop(true);
			return;
		}
		voice.start(conn.url, conn.token).catch(() => showNotice("microphone unavailable — check permissions"));
	}, [conn, voice, showNotice]);

	// leaving a machine (or unmount) ends its voice session — user-initiated:
	// this device no longer wants the mic, so a later unlock must not re-arm it
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the connection change should end a session
	useEffect(() => {
		return () => void voice.stop(true);
	}, [conn?.id]);

	// peer reports stay tappable longer than a toast flashes, then fade (#13)
	useEffect(() => {
		if (!peerReport) return;
		const t = setTimeout(() => setPeerReport(null), 12_000);
		return () => clearTimeout(t);
	}, [peerReport]);

	// voice notices surface as the standard toast, then fade
	const voiceNotice = voice.state.notice;
	useEffect(() => {
		if (!voiceNotice) return;
		const t = setTimeout(() => voice.clearNotice(), 4000);
		return () => clearTimeout(t);
	}, [voiceNotice, voice.clearNotice]);

	// the chat is the bottom-anchored surface: new messages, agent state changes
	// and re-entering from another tab all land on the latest message. A history
	// page prepend instead restores the previous viewport (anchor on the top msg).
	// biome-ignore lint/correctness/useExhaustiveDependencies: the scroll container is a ref; msgs/agentState/tab are what change the height or remount the list
	useLayoutEffect(() => {
		const el = listRef.current;
		if (!el) return;
		const prepended = prependScrollRef.current;
		if (prepended) {
			prependScrollRef.current = null;
			el.scrollTop = el.scrollHeight - prepended.height + prepended.top;
			return;
		}
		el.scrollTo({ top: el.scrollHeight });
	}, [msgs, agentState, tab]);

	// "load forcibly": scrolling hard to the top pulls the next older page
	const loadOlder = useCallback(() => {
		if (!hasMoreHistory || loadingOlderRef.current) return;
		const oldest = msgs.find((m) => m.ts !== undefined)?.ts;
		if (oldest === undefined || !wsRef.current) return;
		loadingOlderRef.current = true;
		wsRef.current.send(JSON.stringify({ type: "history", before: oldest, limit: HISTORY_PAGE }));
	}, [hasMoreHistory, msgs]);

	// -------------------------------------------------------------- render

	if (!conn)
		return (
			<Pairing
				onDone={(p) => {
					addConnection({ id: p.server, name: hostOf(p.server), url: p.server, token: p.token });
					setTab("chat");
				}}
				notice={notice}
			/>
		);

	if (tab === "themes")
		return (
			<ThemesPage
				theme={theme}
				onPick={(id) => setTheme(id)}
				onBack={() => setTab("chat")}
				keepScreenOn={wake.toggle}
				onKeepScreenOn={wake.setToggle}
			/>
		);

	const statusText = target.id ? peerStatus(sessions, target.id) : omniStatus(agentState, toolLabel, connected, reconn);
	const busy = !target.id && (agentState === "thinking" || agentState === "tool" || agentState === "streaming");
	const visible = msgs.filter((m) => (m.target ?? undefined) === target.id);
	const targetName = target.label;

	return (
		<div className="app">
			<div className="headwrap">
				<header className="presence" onClick={() => setDrawerOpen(true)} aria-label="Sessions">
					<button
						type="button"
						className="iconbtn menu"
						aria-label="Machines"
						onClick={(e) => {
							e.stopPropagation();
							setConnOpen(true);
						}}
					>
						☰
					</button>
					<span className={`avatar ${!connected ? "" : busy ? "busy" : "on"}`} />
					<span className="names">
						<span className="name">
							{targetName} <span className="chev">▾</span>
						</span>
						{statusText && <span className="status">{statusText}</span>}
					</span>
					<button
						type="button"
						className="iconbtn"
						aria-label="Appearance"
						onClick={(e) => {
							e.stopPropagation();
							setTab("themes");
						}}
					>
						◐
					</button>
				</header>

				{drawerOpen && (
					<>
						<div className="backdrop" onClick={() => setDrawerOpen(false)} />
						<SessionDrawer
							sessions={sessions}
							profiles={sessions?.profiles}
							target={target}
							onPick={(t) => {
								setTarget(t);
								setDrawerOpen(false);
							}}
							onUnpair={() => {
								setDrawerOpen(false);
								if (conn) removeConnection(conn.id);
							}}
						/>
					</>
				)}

				{connOpen && (
					<>
						<div className="backdrop" onClick={() => setConnOpen(false)} />
						<ConnectionsDrawer
							connections={connections}
							activeId={conn?.id ?? null}
							connected={connected}
							serverVersion={serverVersion}
							onSwitch={(id) => {
								setActiveId(id);
								setConnOpen(false);
							}}
							onRemove={removeConnection}
							onAdd={(c) => addConnection(c)}
							onClose={() => setConnOpen(false)}
						/>
					</>
				)}
			</div>

			<div
				className="list"
				ref={listRef}
				onScroll={(e) => {
					if (e.currentTarget.scrollTop < 48 && !target.id) loadOlder();
				}}
			>
				{visible.length === 0 && (
					<div className="empty">
						<p className="hi">Hey, it's {targetName}.</p>
						<p className="hint">Tell me what to build, ask about a repo, or tap the mic and just talk.</p>
					</div>
				)}
				{visible.map((m) => {
					const prof = m.profileId ? sessions?.profiles?.[m.profileId] : undefined;
					if (m.tool) {
						return (
							<div key={m.id} className="toolchip">
								{m.tool.label ?? m.id}
							</div>
						);
					}
					if (m.role === "user") {
						return (
							<div key={m.id} id={`msg-${m.id}`} className="row user">
								<div className="bubble user-msg">
									{m.source === "voice" && <span className="mic-glyph">🎙</span>}
									{m.text}
								</div>
								{m.attachments?.length ? (
									<AttachmentChips attachments={m.attachments} token={conn?.token ?? ""} />
								) : null}
								<MsgCopyButton text={m.text} />
							</div>
						);
					}
					if (prof) {
						// a profiled agent replied (delegation) — tint the bubble with its color
						return (
							<div key={m.id} id={`msg-${m.id}`} className="row peer">
								<span className="who">{prof.name}</span>
								<div className="bubble peer-msg" style={{ background: prof.color }}>
									{m.text ? <Markdown text={m.text} /> : m.artifacts?.length ? null : "…"}
								</div>
								{m.artifacts?.map((a) => (
									<ArtifactCard key={a.id} artifact={a} onOpen={artifactViewer.open} />
								))}
								{m.tasks?.map((t) => (
									<TaskCard key={t.id} task={liveTask(t, liveTasks)} />
								))}
								<MsgCopyButton text={m.text} />
							</div>
						);
					}
					return (
						<div key={m.id} id={`msg-${m.id}`} className="assistant-msg">
							<span className="dotcol">
								<i />
							</span>
							<div className="assistant-body">
								{m.text ? <Markdown text={m.text} /> : m.artifacts?.length ? null : <span>…</span>}
								{m.artifacts?.map((a) => (
									<ArtifactCard key={a.id} artifact={a} onOpen={artifactViewer.open} />
								))}
								{m.tasks?.map((t) => (
									<TaskCard key={t.id} task={liveTask(t, liveTasks)} />
								))}
								<MsgCopyButton text={m.text} />
							</div>
						</div>
					);
				})}
				{busy && (
					<div className="working">
						<span>{statusText || "thinking…"}</span>
						<button
							type="button"
							className="stop"
							onClick={() => wsRef.current?.send(JSON.stringify({ type: "abort" }))}
						>
							stop
						</button>
					</div>
				)}
			</div>

			{notice && <div className="toast">{notice}</div>}
			{voice.state.notice && <div className="toast">{voice.state.notice}</div>}
			{voiceElsewhere && !voice.on && !voice.state.boot && (
				<div className="toast info">voice active on another screen</div>
			)}
			{peerReport && (
				<PeerReportToast
					profileId={peerReport.profileId}
					preview={peerReport.preview}
					profiles={sessions?.profiles}
					onTap={() => {
						const id = peerReport.id;
						setPeerReport(null);
						setTarget(OMNI()); // the reply lives in the omni lane
						// land after the target switch re-renders the list
						setTimeout(() => {
							const hit = document.getElementById(`msg-${id}`);
							if (hit) hit.scrollIntoView({ block: "center" });
							else listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
						}, 50);
					}}
				/>
			)}

			<div className="composer-wrap">
				{voice.on && <VoiceWave inLevel={voice.levels.mic} outLevel={voice.levels.out} phase={voice.state.phase} />}
				<div className="pill">
					{busy && <div className="hairline" />}
					{(voice.on || voice.state.boot) && (
						<>
							{voice.state.boot ? (
								<div className="voice-state booting">
									<span className="hint-line">
										<span className="pulse-dots" aria-hidden>
											<i />
											<i />
											<i />
										</span>
										{voice.state.boot === "connecting" && "connecting…"}
										{voice.state.boot === "reconnecting" && "connection blipped — reaching your Mac again…"}
										{voice.state.boot === "warming" &&
											(voice.state.bootDetail
												? `waking up the agent's ears — ${voice.state.bootDetail}`
												: "waking up the agent's ears…")}
									</span>
								</div>
							) : (
								<div className={`voice-state ${voice.state.phase}`}>
									{voice.state.phase === "listening" && <span className="hint-line">listening — just talk</span>}
									{voice.state.phase === "user-speaking" && (
										<span className="cap">
											{voice.state.committed && <b>{voice.state.committed} </b>}
											{voice.state.tentative}
											{!voice.state.committed && !voice.state.tentative && (
												<i>{voice.state.stalled ? "STT is quiet — I'll transcribe when you pause" : "hearing you…"}</i>
											)}
										</span>
									)}
									{voice.state.phase === "thinking" && <span className="hint-line">thinking…</span>}
									{voice.state.phase === "agent-speaking" && (
										<span className="hint-line">
											talking… tap stop to interrupt
											<button type="button" className="stop" onClick={voice.interrupt}>
												stop
											</button>
										</span>
									)}
								</div>
							)}
							<button
								type="button"
								className={`mic ${voice.on ? "rec" : "boot"}`}
								onClick={toggleVoice}
								aria-label={voice.on ? "end voice session" : "cancel voice startup"}
							>
								{voice.on ? "■" : "●"}
							</button>
						</>
					)}
					{!voice.on && !voice.state.boot && (
						<>
							{pendingFiles.length > 0 && (
								<div className="attach-chips">
									{pendingFiles.map((f) => (
										<span className="attach-chip" key={f.id}>
											<img src={f.url} alt={f.file.name} />
											<button
												type="button"
												aria-label={`remove ${f.file.name}`}
												onClick={() => {
													URL.revokeObjectURL(f.url);
													setPendingFiles((prev) => prev.filter((x) => x.id !== f.id));
												}}
											>
												✕
											</button>
										</span>
									))}
								</div>
							)}
							<button
								type="button"
								className="attach"
								aria-label="attach images"
								onClick={() => fileInputRef.current?.click()}
							>
								📎
							</button>
							<input
								ref={fileInputRef}
								type="file"
								accept="image/png,image/jpeg,image/webp"
								multiple
								hidden
								onChange={(e) => {
									const files = Array.from(e.target.files ?? []);
									if (files.length) {
										setPendingFiles((prev) => [
											...prev,
											...files.map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) })),
										]);
									}
									e.target.value = "";
								}}
							/>

							<input
								value={textInput}
								onChange={(e) => setTextInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										sendText();
									}
								}}
								placeholder={`Message ${targetName}…`}
								aria-label={`Message ${targetName}`}
							/>
							<button type="button" className="mic" onClick={toggleVoice} aria-label="start voice conversation">
								●
							</button>
						</>
					)}
				</div>
			</div>

			<StatusBar
				status={agentStatus}
				models={modelList}
				active={!target.id}
				targetLabel={targetName}
				send={(msg) => wsRef.current?.send(JSON.stringify(msg))}
				notify={showNotice}
			/>

			{artifactViewer.viewer}
		</div>
	);
}

/** issue #12: one-tap full-message copy — plain text for markdown bodies */
function MsgCopyButton({ text }: { text: string }) {
	const [state, setState] = useState<"ok" | "fail" | null>(null);
	const onCopy = async () => {
		const ok = await copyTextToClipboard(messageToPlainText(text));
		setState(ok ? "ok" : "fail");
		setTimeout(() => setState(null), 1400);
	};
	return (
		<button
			type="button"
			className={`msg-copy ${state ?? ""}`.trim()}
			aria-label="Copy message text"
			onClick={() => void onCopy()}
		>
			{state === "ok" ? "copied ✓" : state === "fail" ? "copy failed — select manually" : "⧉ copy"}
		</button>
	);
}

function peerStatus(sessions: SessionsResponse | null, id: string): string {
	for (const p of sessions?.projects ?? []) {
		const s = p.sessions.find((x) => x.sessionId === id);
		if (s) return s.state === "busy" ? "working…" : s.state === "unreachable" ? "unreachable" : "";
	}
	const o = sessions?.others.find((x) => x.sessionId === id);
	if (o) return o.state === "busy" ? "working…" : o.state === "unreachable" ? "unreachable" : "";
	return "";
}

function ConnectionsDrawer(props: {
	connections: Connection[];
	activeId: string | null;
	connected: boolean;
	serverVersion: string;
	onSwitch: (id: string) => void;
	onRemove: (id: string) => void;
	onAdd: (c: Connection) => void;
	onClose: () => void;
}) {
	const onAdd = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const data = new FormData(e.currentTarget);
		const parsed = parsePairInput(String(data.get("link") ?? ""), String(data.get("token") ?? ""));
		if (!parsed) return;
		props.onAdd({ id: parsed.url, name: hostOf(parsed.url), url: parsed.url, token: parsed.token });
		e.currentTarget.reset();
	};

	// two gateways can share a machine name (same hostname, different hosts/ports) —
	// suffix those rows with the connection's host:port so they're told apart
	const dupNames = new Set(
		props.connections.filter((c) => props.connections.some((o) => o !== c && o.name === c.name)).map((c) => c.name),
	);

	return (
		<div className="conn-drawer" onClick={(e) => e.stopPropagation()}>
			<h3>Machines</h3>
			{props.serverVersion && <p className="conn-ver">gateway {props.serverVersion}</p>}
			{props.connections.length === 0 && <p className="conn-empty">No machines paired yet.</p>}
			{props.connections.map((c) => (
				<div key={c.id} className={`crow ${c.id === props.activeId ? "active" : ""}`}>
					<button type="button" className="crow-main" onClick={() => props.onSwitch(c.id)}>
						<span className="cdot" style={{ background: c.color ?? "var(--dim)" }} />
						<span className="cname">{dupNames.has(c.name) ? `${c.name} · ${hostOf(c.url)}` : c.name}</span>
						{c.id === props.activeId && <span className="ctag">{props.connected ? "online" : "offline"}</span>}
					</button>
					<button type="button" className="crow-x" aria-label={`Remove ${c.name}`} onClick={() => props.onRemove(c.id)}>
						✕
					</button>
				</div>
			))}
			<form className="cadd" onSubmit={onAdd}>
				<input name="link" placeholder="Paste pair link or server URL" autoComplete="off" />
				<input name="token" placeholder="Token (skip if the link has one)" autoComplete="off" />
				<button type="submit">Add machine</button>
			</form>
			<p className="conn-hint">Run /pppi_pair in any pi session on the machine to get a link or QR.</p>
		</div>
	);
}

function Pairing({ onDone, notice }: { onDone: (p: Pairing) => void; notice: string | null }) {
	return (
		<div style={{ maxWidth: 420, margin: "12vh auto 0", padding: "0 20px" }}>
			<pre
				style={{
					color: "var(--dim)",
					fontSize: 12,
					lineHeight: 1.25,
					fontFamily: "var(--font-mono)",
					overflowX: "auto",
				}}
			>{`   ┌──────┐        ┌──────┐        ┌──────┐
   │ pppi │ ─────► │  *p  │ ─────► │  pi  │
   └──────┘        └──────┘        └──────┘`}</pre>
			<h1 style={{ fontSize: 22 }}>Pair with your omni agent</h1>
			<p style={{ color: "var(--dim)" }}>
				Paste the pair link from <code style={{ fontFamily: "var(--font-mono)" }}>/pppi_pair</code> — or run the pppi
				server on your Mac and enter its URL + token. Secrets never leave the machine.
			</p>
			<form
				style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 22 }}
				onSubmit={(e) => {
					e.preventDefault();
					const data = new FormData(e.currentTarget);
					const server = String(data.get("server") ?? "").replace(/\/$/, "");
					const token = String(data.get("token") ?? "").trim();
					const parsed = parsePairInput(server, token);
					if (parsed) onDone({ server: parsed.url, token: parsed.token });
				}}
			>
				<label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--dim)" }}>
					Pair link or server URL
					<input
						name="server"
						required
						defaultValue={
							location.search.includes("pair=")
								? location.href
								: (new URLSearchParams(location.search).get("server") ??
									// static host (GitHub Pages etc.): the gateway lives elsewhere
									(location.origin.includes("5173")
										? "http://localhost:8787"
										: location.protocol === "https:"
											? ""
											: location.origin))
						}
						style={fieldStyle}
					/>
				</label>
				<label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--dim)" }}>
					Pairing token
					<input name="token" placeholder="printed by the server" required autoComplete="off" style={fieldStyle} />
				</label>
				<button
					type="submit"
					style={{
						background: "var(--accent)",
						color: "var(--accent-ink)",
						border: 0,
						borderRadius: 999,
						padding: "12px 16px",
						fontWeight: 600,
						fontSize: 15,
						cursor: "pointer",
					}}
				>
					Connect
				</button>
			</form>
			{notice && <p style={{ color: "var(--danger)" }}>{notice}</p>}
		</div>
	);
}

const fieldStyle: React.CSSProperties = {
	background: "var(--surface)",
	border: "1px solid var(--line)",
	borderRadius: 12,
	padding: "12px 14px",
	color: "var(--text)",
	font: "inherit",
	fontSize: 16,
};

function ThemesPage({
	theme,
	onPick,
	onBack,
	keepScreenOn,
	onKeepScreenOn,
}: {
	theme: ThemeId;
	onPick: (id: ThemeId) => void;
	onBack: () => void;
	keepScreenOn: boolean;
	onKeepScreenOn: (enabled: boolean) => void;
}) {
	return (
		<div className="themes">
			<header>
				<button
					type="button"
					className="presence iconbtn"
					aria-label="Back"
					onClick={onBack}
					style={{ padding: "4px 8px" }}
				>
					←
				</button>
				<h1>Appearance</h1>
			</header>
			<p className="sub">Pick the mood. Applies instantly on every screen.</p>
			<div className="grid">
				{THEMES.map((t) => (
					<button
						type="button"
						key={t.id}
						className={`tcard ${theme === t.id ? "current" : ""}`}
						data-theme={t.id}
						onClick={() => onPick(t.id)}
					>
						<div className="preview">
							<div className="pv-user">is the build green?</div>
							<div className="pv-bot">Yep — 264 passing.</div>
							<div className="pv-bot" style={{ opacity: 0.6 }}>
								writing report…
							</div>
						</div>
						<div className="meta">
							<span>
								<span className="tname">{t.name}</span>
								<br />
								<span className="tmood">{t.mood}</span>
							</span>
							{theme === t.id && <span className="current-mark">●</span>}
						</div>
					</button>
				))}
			</div>

			<div className="settings">
				<div className="settings-row">
					<div>
						<p className="s-title">Keep screen on</p>
						<p className="s-hint">Awake while the agent talks or streams — otherwise the screen sleeps normally.</p>
					</div>
					<button
						type="button"
						className={`switch ${keepScreenOn ? "on" : ""}`}
						role="switch"
						aria-checked={keepScreenOn}
						aria-label="Keep screen on"
						onClick={() => onKeepScreenOn(!keepScreenOn)}
					>
						<span className="knob" />
					</button>
				</div>
			</div>
		</div>
	);
}
