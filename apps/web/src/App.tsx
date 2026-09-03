import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceRecorder } from "./audio.ts";
import { THEMES, applyTheme, loadTheme, type ThemeId } from "./theme.ts";
import type { AgentState, ChatEntry, SessionsResponse, ServerEvent } from "@sspi/protocol";

type Pairing = { server: string; token: string };
type Target = { id: string | undefined; label: string };

type Msg = {
	id: string;
	role: "user" | "assistant";
	text: string;
	source?: "voice" | "text";
	target?: string;
	tool?: { phase: "start" | "end"; label?: string };
};

const OMNI = (): Target => ({ id: undefined, label: "Omni" });

function loadPairing(): Pairing | null {
	try {
		const raw = localStorage.getItem("sspi.pairing");
		if (raw) return JSON.parse(raw);
	} catch {
		// ignore
	}
	const fromUrl = new URLSearchParams(location.search);
	if (fromUrl.get("token")) return { server: location.origin, token: fromUrl.get("token")! };
	return null;
}

/** PRD §5 grammar — the omni session's one-line status. */
function omniStatus(state: AgentState, toolLabel: string | null, connected: boolean): string {
	if (!connected) return "connecting…";
	switch (state) {
		case "thinking":
			return "thinking…";
		case "tool":
			return (toolLabel ?? "working") + "…";
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
	const [pairing, setPairing] = useState<Pairing | null>(loadPairing);
	const [connected, setConnected] = useState(false);
	const [msgs, setMsgs] = useState<Msg[]>([]);
	const [agentState, setAgentState] = useState<AgentState>("starting");
	const [toolLabel, setToolLabel] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [target, setTarget] = useState<Target>(OMNI);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [sessions, setSessions] = useState<SessionsResponse | null>(null);
	const [showProjects, setShowProjects] = useState(() => localStorage.getItem("sspi.projects") === "1");
	const [showWorktrees, setShowWorktrees] = useState(() => localStorage.getItem("sspi.worktrees") === "1");
	const [recording, setRecording] = useState(false);
	const [level, setLevel] = useState(0);
	const [textInput, setTextInput] = useState("");
	const wsRef = useRef<WebSocket | null>(null);
	const recorderRef = useRef<VoiceRecorder | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const levelRef = useRef(0);

	useEffect(() => applyTheme(theme), [theme]);

	const showNotice = useCallback((message: string) => {
		setNotice(message);
		setTimeout(() => setNotice((cur) => (cur === message ? null : cur)), 6000);
	}, []);

	// -------------------------------------------------------------- websocket

	useEffect(() => {
		if (!pairing) return;
		const wsUrl = `${pairing.server.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
		let closed = false;
		let retry: ReturnType<typeof setTimeout> | null = null;
		const connect = () => {
			if (closed) return;
			const ws = new WebSocket(wsUrl);
			wsRef.current = ws;
			ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: pairing.token, client: "web" }));
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
	}, [pairing]);

	function handleEvent(evt: ServerEvent) {
		switch (evt.type) {
			case "hello_ok":
				setConnected(true);
				setAgentState(evt.agent.state);
				setMsgs(evt.history.map((h: ChatEntry) => ({ ...h })));
				break;
			case "hello_fail":
				showNotice(evt.error);
				setPairing(null);
				localStorage.removeItem("sspi.pairing");
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
					return [...b, { id: evt.id, role: "assistant", text: evt.delta, target: evt.target }];
				});
				break;
			case "assistant_final":
				setMsgs((b) => {
					const idx = b.findIndex((x) => x.id === evt.id);
					if (idx >= 0) {
						const copy = [...b];
						copy[idx] = { ...copy[idx]!, text: evt.text };
						return copy;
					}
					return [...b, { id: evt.id, role: "assistant", text: evt.text, target: evt.target }];
				});
				break;
			case "tool_event":
				if (evt.phase === "start") {
					setAgentState("tool");
					setToolLabel(evt.label ?? evt.toolName);
					setMsgs((b) => [...b.slice(-40), { id: `tool-${evt.toolName}-${Date.now()}`, role: "assistant", text: "", tool: { phase: "start", label: evt.label } }]);
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
			case "error":
				showNotice(evt.message);
				break;
		}
	}

	// -------------------------------------------------------------- sessions poll

	const refreshSessions = useCallback(async () => {
		if (!pairing) return;
		try {
			const res = await fetch(`${pairing.server.replace(/\/$/, "")}/api/sessions`, {
				headers: { authorization: `Bearer ${pairing.token}` },
			});
			if (res.ok) setSessions(await res.json());
		} catch {
			// ignore — sheet shows stale data
		}
	}, [pairing]);

	useEffect(() => {
		if (!sheetOpen) return;
		refreshSessions();
		const t = setInterval(refreshSessions, 5000);
		return () => clearInterval(t);
	}, [sheetOpen, refreshSessions]);

	// -------------------------------------------------------------- actions

	const sendText = useCallback(() => {
		const text = textInput.trim();
		if (!text || !wsRef.current) return;
		wsRef.current.send(JSON.stringify({ type: "chat", text, target: target.id }));
		setTextInput("");
	}, [textInput, target]);

	const toggleMic = useCallback(async () => {
		if (recording) {
			const rec = recorderRef.current;
			recorderRef.current = null;
			setRecording(false);
			if (!rec) return;
			const { wav } = await rec.stop();
			const res = await fetch(`${pairing!.server.replace(/\/$/, "")}/api/voice`, {
				method: "POST",
				headers: { authorization: `Bearer ${pairing!.token}`, "content-type": "audio/wav" },
				body: wav,
			});
			const body = await res.json().catch(() => ({ error: "bad response" }));
			if (!res.ok || !body.ok) showNotice(body.error ?? `voice failed (${res.status})`);
			return;
		}
		try {
			const rec = new VoiceRecorder();
			rec.onLevel = (v) => {
				if (Math.abs(v - levelRef.current) > 0.04) {
					levelRef.current = v;
					setLevel(v);
				}
			};
			await rec.start();
			recorderRef.current = rec;
			setRecording(true);
		} catch {
			showNotice("microphone unavailable — check permissions");
		}
	}, [recording, pairing, showNotice]);

	useEffect(() => {
		listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
	}, [msgs, agentState]);

	// -------------------------------------------------------------- render

	if (!pairing) return <Pairing onDone={setPairing} notice={notice} />;

	if (tab === "themes")
		return (
			<ThemesPage
				theme={theme}
				onPick={(id) => setTheme(id)}
				onBack={() => setTab("chat")}
			/>
		);

	const statusText = target.id
		? peerStatus(sessions, target.id)
		: omniStatus(agentState, toolLabel, connected);
	const busy = !target.id && (agentState === "thinking" || agentState === "tool" || agentState === "streaming");
	const visible = msgs.filter((m) => (m.target ?? undefined) === target.id);
	const targetName = target.label;

	return (
		<div className="app">
			<header className="presence" onClick={() => setSheetOpen(true)} aria-label="Sessions">
				<span className={`avatar ${!connected ? "" : busy ? "busy" : "on"}`} />
				<span className="names">
					<span className="name">
						{targetName} <span className="chev">▾</span>
					</span>
					{statusText && <span className="status">{statusText}</span>}
				</span>
				<button
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

			<div className="list" ref={listRef}>
				{visible.length === 0 && (
					<div className="empty">
						<p className="hi">Hey, it's Omni.</p>
						<p className="hint">
							Tell me what to build, ask about a repo, or hold the mic and just talk.
						</p>
					</div>
				)}
				{visible.map((m) =>
					m.tool ? (
						<div key={m.id} className="toolchip">{m.tool.label ?? m.id}</div>
					) : m.role === "user" ? (
						<div key={m.id} className="row user">
							<div className="bubble user-msg">
								{m.source === "voice" && <span className="mic-glyph">🎙</span>}
								{m.text}
							</div>
						</div>
					) : (
						<div key={m.id} className="assistant-msg">
							<span className="dotcol">
								<i />
							</span>
							<span>{m.text || "…"}</span>
						</div>
					),
				)}
				{busy && (
					<div className="working">
						<span>{statusText || "thinking…"}</span>
						<button className="stop" onClick={() => wsRef.current?.send(JSON.stringify({ type: "abort" }))}>
							stop
						</button>
					</div>
				)}
			</div>

			{notice && <div className="toast">{notice}</div>}

			<div className="composer-wrap">
				<div className="pill">
					{busy && <div className="hairline" />}
					{recording ? (
						<>
							<div className="listen">
								{[...Array(9)].map((_, i) => (
									<span
										key={i}
										className="bar"
										style={{ height: `${6 + Math.abs(Math.sin(i * 1.7 + level * 30)) * 22 * (0.3 + level * 4)}px` }}
									/>
								))}
								<span style={{ marginLeft: 8 }}>listening… release to send</span>
							</div>
						</>
					) : (
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
					)}
					<button
						className={`mic ${recording ? "rec" : ""}`}
						onClick={toggleMic}
						aria-label={recording ? "stop and send" : "start recording"}
					>
						{recording ? "■" : "●"}
					</button>
				</div>
			</div>

			{sheetOpen && (
				<>
					<div className="backdrop" onClick={() => setSheetOpen(false)} />
					<SessionSheet
						sessions={sessions}
						target={target}
						showProjects={showProjects}
						showWorktrees={showWorktrees}
						onPick={(t) => {
							setTarget(t);
							setSheetOpen(false);
						}}
						onClose={() => setSheetOpen(false)}
						onToggleProjects={(v) => {
							setShowProjects(v);
							localStorage.setItem("sspi.projects", v ? "1" : "0");
						}}
						onToggleWorktrees={(v) => {
							setShowWorktrees(v);
							localStorage.setItem("sspi.worktrees", v ? "1" : "0");
						}}
						onUnpair={() => {
							setSheetOpen(false);
							setPairing(null);
							localStorage.removeItem("sspi.pairing");
						}}
					/>
				</>
			)}
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

function SessionSheet(props: {
	sessions: SessionsResponse | null;
	target: Target;
	showProjects: boolean;
	showWorktrees: boolean;
	onPick: (t: Target) => void;
	onClose: () => void;
	onToggleProjects: (v: boolean) => void;
	onToggleWorktrees: (v: boolean) => void;
	onUnpair: () => void;
}) {
	const { sessions, target } = props;
	const peerRow = (
		label: string,
		id: string,
		state: string,
		depth: number,
	): React.ReactNode => (
		<button
			key={id}
			className={`srow ${target.id === id ? "active" : ""}`}
			style={{ paddingLeft: 20 + depth * 22 }}
			onClick={() => props.onPick({ id, label })}
		>
			<span className="ring" />
			<span className="sname">{label}</span>
			<span className="sstate">{state === "busy" ? "working…" : state === "unreachable" ? "unreachable" : "idle"}</span>
		</button>
	);

	return (
		<div className="sheet" onClick={(e) => e.stopPropagation()}>
			<h3>Sessions</h3>
			<button
				className={`srow ${!target.id ? "active" : ""}`}
				onClick={() => props.onPick(OMNI())}
			>
				<span className="ring" />
				<span className="sname">Omni</span>
				<span className="sstate">the whole fleet</span>
			</button>

			{props.showProjects && (
				<>
					<div className="sep" />
					<h3>Projects</h3>
					{(sessions?.projects ?? []).flatMap((p) => {
						const rows = p.sessions
							.filter((s) => !s.worktree)
							.map((s) =>
								peerRow(
									s.name ? `${p.name} · ${s.name}` : `${p.name} · main`,
									s.sessionId,
									s.state,
									1,
								),
							);
						if (rows.length === 0)
							rows.push(
								<div key={`${p.name}-empty`} className="srow" style={{ paddingLeft: 42, color: "var(--dim)", fontSize: 14 }}>
									<span className="sname" style={{ fontWeight: 400 }}>{p.name} — no open session</span>
								</div>,
							);
						if (props.showWorktrees) {
							for (const s of p.sessions) {
								if (!s.worktree) continue;
								rows.push(peerRow(`wt/${s.worktree}`, s.sessionId, s.state, 2));
							}
						}
						return rows;
					})}
					{(sessions?.others ?? []).map((s) => peerRow(s.name ?? `#${s.sessionId.slice(0, 4)}`, s.sessionId, s.state, 1))}
				</>
			)}

			<div className="sep" />
			<div className="toggle-row">
				Show projects
				<button
					className={`switch ${props.showProjects ? "on" : ""}`}
					aria-label="Show projects"
					onClick={() => props.onToggleProjects(!props.showProjects)}
				/>
			</div>
			{props.showProjects && (
				<div className="toggle-row">
					Show worktrees
					<button
						className={`switch ${props.showWorktrees ? "on" : ""}`}
						aria-label="Show worktrees"
						onClick={() => props.onToggleWorktrees(!props.showWorktrees)}
					/>
				</div>
			)}
			<div className="footer">
				<button className="unpair" onClick={props.onUnpair}>
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
				Run the sspi server on your Mac; it prints a pairing token. Secrets never leave the Mac.
			</p>
			<form
				style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 22 }}
				onSubmit={(e) => {
					e.preventDefault();
					const data = new FormData(e.currentTarget);
					const server = String(data.get("server") ?? "").replace(/\/$/, "");
					const token = String(data.get("token") ?? "").trim();
					if (server && token) {
						localStorage.setItem("sspi.pairing", JSON.stringify({ server, token }));
						onDone({ server, token });
					}
				}}
			>
				<label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--dim)" }}>
					Server
					<input
						name="server"
						required
						defaultValue={location.origin.includes("5173") ? "http://localhost:8787" : location.origin}
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
				<button className="presence iconbtn" aria-label="Back" onClick={onBack} style={{ padding: "4px 8px" }}>
					←
				</button>
				<h1>Appearance</h1>
			</header>
			<p className="sub">Pick the mood. Applies instantly on every screen.</p>
			<div className="grid">
				{THEMES.map((t) => (
					<button
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
