import type { AgentState, AgentStatus, ChatEntry, ModelInfo, ServerEvent, SessionsResponse } from "@sspi/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { StatusBar } from "./status/StatusBar.tsx";
import { THEMES, type ThemeId, applyTheme, loadTheme } from "./theme.ts";
import { useVoice } from "./voice/useVoice.ts";

type Pairing = { server: string; token: string };
type Target = { id: string | undefined; label: string };

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
	/** ms epoch, set on history entries — anchors older-page loads */
	ts?: number;
};

/** the recent window cached on the client; older pages load only on demand (scroll to top) */
const HISTORY_PAGE = 50;

const OMNI = (): Target => ({ id: undefined, label: "Omni" });

function loadConnections(): Connection[] {
	try {
		const raw = localStorage.getItem("sspi.connections");
		if (raw) {
			const list = JSON.parse(raw) as Connection[];
			if (Array.isArray(list) && list.length) return list;
		}
	} catch {
		// ignore
	}
	// migrate the v0 single-pairing record
	try {
		const raw = localStorage.getItem("sspi.pairing");
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
function omniStatus(state: AgentState, toolLabel: string | null, connected: boolean): string {
	if (!connected) return "connecting…";
	switch (state) {
		case "thinking":
			return "thinking…";
		case "tool":
			return `${toolLabel ?? "working"}…`;
		case "streaming":
			return "typing…";
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
	const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem("sspi.active"));
	const [connected, setConnected] = useState(false);
	const [msgs, setMsgs] = useState<Msg[]>([]);
	const [agentState, setAgentState] = useState<AgentState>("starting");
	const [toolLabel, setToolLabel] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [target, setTarget] = useState<Target>(OMNI);
	const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
	const [modelList, setModelList] = useState<ModelInfo[]>([]);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [connOpen, setConnOpen] = useState(false);
	const [sessions, setSessions] = useState<SessionsResponse | null>(null);
	const [textInput, setTextInput] = useState("");
	const [hasMoreHistory, setHasMoreHistory] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	/** guards one in-flight older-page load at a time */
	const loadingOlderRef = useRef(false);
	/** set when prepending a history page so the scroll effect restores position instead of jumping to bottom */
	const prependScrollRef = useRef<{ height: number; top: number } | null>(null);
	const voice = useVoice();

	const conn = connections.find((c) => c.id === activeId) ?? connections[0] ?? null;

	useEffect(() => applyTheme(theme), [theme]);

	useEffect(() => {
		localStorage.setItem("sspi.connections", JSON.stringify(connections));
		if (connections.length) localStorage.removeItem("sspi.pairing"); // v0 key
	}, [connections]);

	useEffect(() => {
		if (activeId) localStorage.setItem("sspi.active", activeId);
	}, [activeId]);

	// ?pair=<token> onboarding: opening the gateway's pair link pairs this browser
	useEffect(() => {
		const token = new URLSearchParams(location.search).get("pair");
		if (!token) return;
		const url = location.origin;
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
		let retry: ReturnType<typeof setTimeout> | null = null;
		const connect = () => {
			if (closed) return;
			const ws = new WebSocket(wsUrl);
			wsRef.current = ws;
			ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: conn.token, client: "web" }));
			ws.onmessage = (m) => handleEvent(JSON.parse(m.data) as ServerEvent);
			ws.onclose = () => {
				setConnected(false);
				if (!closed) retry = setTimeout(connect, 2000);
			};
		};
		connect();
		return () => {
			closed = true;
			if (retry) clearTimeout(retry);
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
	}, []);

	function handleEvent(evt: ServerEvent) {
		switch (evt.type) {
			case "hello_ok":
				setConnected(true);
				setAgentState(evt.agent.state);
				setMsgs(evt.history.map((h: ChatEntry) => ({ ...h })));
				setHasMoreHistory(evt.history.length >= HISTORY_PAGE);
				if (conn) void learnAbout(conn);
				break;
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
					const patch = (m: Msg): Msg => ({ ...m, text: evt.text, profileId: evt.profileId });
					if (idx >= 0) {
						const copy = [...b];
						copy[idx] = patch(copy[idx]!);
						return copy;
					}
					return [
						...b,
						{ id: evt.id, role: "assistant", text: evt.text, target: evt.target, profileId: evt.profileId },
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
			case "error":
				showNotice(evt.message);
				loadingOlderRef.current = false; // a failed history page must not wedge the guard
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
		if (!text || !wsRef.current) return;
		wsRef.current.send(JSON.stringify({ type: "chat", text, target: target.id }));
		setTextInput("");
	}, [textInput, target]);

	const toggleVoice = useCallback(() => {
		if (!conn) return;
		if (voice.on) {
			void voice.stop();
			return;
		}
		voice.start(conn.url, conn.token).catch(() => showNotice("microphone unavailable — check permissions"));
	}, [conn, voice, showNotice]);

	// leaving a machine (or unmount) ends its voice session
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the connection change should end a session
	useEffect(() => {
		return () => void voice.stop();
	}, [conn?.id]);

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

	if (tab === "themes") return <ThemesPage theme={theme} onPick={(id) => setTheme(id)} onBack={() => setTab("chat")} />;

	const statusText = target.id ? peerStatus(sessions, target.id) : omniStatus(agentState, toolLabel, connected);
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
						<p className="hint">Tell me what to build, ask about a repo, or hold the mic and just talk.</p>
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
							<div key={m.id} className="row user">
								<div className="bubble user-msg">
									{m.source === "voice" && <span className="mic-glyph">🎙</span>}
									{m.text}
								</div>
							</div>
						);
					}
					if (prof) {
						// a profiled agent replied (delegation) — tint the bubble with its color
						return (
							<div key={m.id} className="row peer">
								<span className="who">{prof.name}</span>
								<div className="bubble peer-msg" style={{ background: prof.color }}>
									{m.text || "…"}
								</div>
							</div>
						);
					}
					return (
						<div key={m.id} className="assistant-msg">
							<span className="dotcol">
								<i />
							</span>
							<span>{m.text || "…"}</span>
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

			<div className="composer-wrap">
				<div className="pill">
					{busy && <div className="hairline" />}
					{voice.on ? (
						<>
							<div className={`voice-state ${voice.state.phase}`}>
								{voice.state.phase === "listening" && <span className="hint-line">listening — just talk</span>}
								{voice.state.phase === "user-speaking" && (
									<span className="cap">
										{voice.state.committed && <b>{voice.state.committed} </b>}
										{voice.state.tentative}
										{!voice.state.committed && !voice.state.tentative && <i>…</i>}
									</span>
								)}
								{voice.state.phase === "thinking" && <span className="hint-line">thinking…</span>}
								{voice.state.phase === "agent-speaking" && (
									<span className="hint-line">
										talking… speak up to interrupt
										<button type="button" className="stop" onClick={voice.interrupt}>
											stop
										</button>
									</span>
								)}
							</div>
							<button type="button" className="mic rec" onClick={toggleVoice} aria-label="end voice session">
								■
							</button>
						</>
					) : (
						<>
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
		</div>
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

	return (
		<div className="conn-drawer" onClick={(e) => e.stopPropagation()}>
			<h3>Machines</h3>
			{props.connections.length === 0 && <p className="conn-empty">No machines paired yet.</p>}
			{props.connections.map((c) => (
				<div key={c.id} className={`crow ${c.id === props.activeId ? "active" : ""}`}>
					<button type="button" className="crow-main" onClick={() => props.onSwitch(c.id)}>
						<span className="cdot" style={{ background: c.color ?? "var(--dim)" }} />
						<span className="cname">{c.name}</span>
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
			<p className="conn-hint">Run /pair in any pi session on the machine to get a link or QR.</p>
		</div>
	);
}

function SessionDrawer(props: {
	sessions: SessionsResponse | null;
	target: Target;
	onPick: (t: Target) => void;
	onUnpair: () => void;
}) {
	const { sessions, target } = props;
	const stateLabel = (state: string) =>
		state === "busy" ? "working…" : state === "unreachable" ? "unreachable" : "idle";
	const peerRow = (label: string, id: string, state: string, depth: number): React.ReactNode => (
		<button
			type="button"
			key={id}
			className={`srow ${target.id === id ? "active" : ""}`}
			onClick={() => props.onPick({ id, label })}
		>
			{Array.from({ length: depth }, (_, i) => i).map((v) => (
				<span key={`guide-${v}`} className="guide" aria-hidden />
			))}
			<span className="ring" />
			<span className="sname">{label}</span>
			<span className="sstate">{stateLabel(state)}</span>
		</button>
	);

	return (
		<div className="drawer" onClick={(e) => e.stopPropagation()}>
			<h3>Sessions</h3>
			<button type="button" className={`srow ${!target.id ? "active" : ""}`} onClick={() => props.onPick(OMNI())}>
				<span className="ring" />
				<span className="sname">Omni</span>
				<span className="sstate">the whole fleet</span>
			</button>

			{(sessions?.projects ?? []).map((p) => {
				const mains = p.sessions.filter((s) => !s.worktree);
				const wts = p.sessions.filter((s) => s.worktree);
				return (
					<div key={p.name}>
						{mains.length === 0 && (
							<div className="srow empty-row">
								<span className="guide" aria-hidden />
								<span className="sname">{p.name} — no open session</span>
							</div>
						)}
						{mains.map((s, i) => peerRow(i === 0 ? p.name : (s.name ?? "main"), s.sessionId, s.state, 1))}
						{wts.map((s) => peerRow(s.worktree ?? "", s.sessionId, s.state, 2))}
					</div>
				);
			})}
			{(sessions?.others ?? []).map((s) => peerRow(s.name ?? `#${s.sessionId.slice(0, 4)}`, s.sessionId, s.state, 1))}

			<div className="sep" />
			<div className="footer">
				<button type="button" className="unpair" onClick={props.onUnpair}>
					Unpair this device
				</button>
			</div>
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
   │ sspi │ ─────► │  *p  │ ─────► │  pi  │
   └──────┘        └──────┘        └──────┘`}</pre>
			<h1 style={{ fontSize: 22 }}>Pair with your omni agent</h1>
			<p style={{ color: "var(--dim)" }}>
				Paste the pair link from <code style={{ fontFamily: "var(--font-mono)" }}>/pair</code> — or run the sspi server
				on your Mac and enter its URL + token. Secrets never leave the machine.
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
								: location.origin.includes("5173")
									? "http://localhost:8787"
									: location.origin
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
}: {
	theme: ThemeId;
	onPick: (id: ThemeId) => void;
	onBack: () => void;
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
		</div>
	);
}
