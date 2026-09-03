import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceRecorder } from "./audio.ts";
import type { AgentState, ChatEntry, ServerEvent } from "@sspi/protocol";

type Pairing = { server: string; token: string };

type Bubble = {
	id: string;
	role: "user" | "assistant";
	text: string;
	source?: "voice" | "text";
	streaming?: boolean;
};

function loadPairing(): Pairing | null {
	try {
		const raw = localStorage.getItem("sspi.pairing");
		if (raw) return JSON.parse(raw);
	} catch {
		// ignore
	}
	const fromUrl = new URLSearchParams(location.search);
	if (fromUrl.get("token")) {
		return { server: location.origin, token: fromUrl.get("token")! };
	}
	return null;
}

export default function App() {
	const [pairing, setPairing] = useState<Pairing | null>(loadPairing);
	const [connected, setConnected] = useState(false);
	const [bubbles, setBubbles] = useState<Bubble[]>([]);
	const [agentState, setAgentState] = useState<AgentState>("starting");
	const [toolLabel, setToolLabel] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [recording, setRecording] = useState(false);
	const [level, setLevel] = useState(0);
	const [textInput, setTextInput] = useState("");
	const wsRef = useRef<WebSocket | null>(null);
	const recorderRef = useRef<VoiceRecorder | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const levelRef = useRef(0);

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

	function showNotice(message: string) {
		setNotice(message);
		setTimeout(() => setNotice((cur) => (cur === message ? null : cur)), 6000);
	}

	function handleEvent(evt: ServerEvent) {
		switch (evt.type) {
			case "hello_ok":
				setConnected(true);
				setAgentState(evt.agent.state);
				setBubbles(
					evt.history.map((h: ChatEntry) => ({ id: h.id, role: h.role, text: h.text, source: h.source })),
				);
				break;
			case "hello_fail":
				showNotice(evt.error);
				setPairing(null);
				localStorage.removeItem("sspi.pairing");
				break;
			case "transcript":
				setBubbles((b) => [
					...b.filter((x) => x.id !== evt.id),
					{ id: evt.id, role: "user", text: evt.text, source: "voice" },
				]);
				break;
			case "user_message":
				setBubbles((b) =>
					b.some((x) => x.id === evt.id)
						? b.map((x) => (x.id === evt.id ? { ...x, text: evt.text, source: evt.source } : x))
						: [...b, { id: evt.id, role: "user", text: evt.text, source: evt.source }],
				);
				break;
			case "assistant_delta":
				setBubbles((b) => {
					const last = b.at(-1);
					if (last && last.role === "assistant" && last.id === evt.id) {
						return [...b.slice(0, -1), { ...last, text: last.text + evt.delta, streaming: true }];
					}
					return [...b, { id: evt.id, role: "assistant", text: evt.delta, streaming: true }];
				});
				break;
			case "assistant_final":
				setBubbles((b) => {
					const idx = b.findIndex((x) => x.id === evt.id);
					if (idx >= 0) {
						const copy = [...b];
						copy[idx] = { ...copy[idx]!, text: evt.text, streaming: false };
						return copy;
					}
					return [...b, { id: evt.id, role: "assistant", text: evt.text, streaming: false }];
				});
				break;
			case "agent_state":
				setAgentState(evt.state);
				setToolLabel(evt.state === "tool" ? (evt.toolName ?? "tool") : null);
				break;
			case "tool_event":
				setToolLabel(evt.phase === "start" ? evt.toolName : null);
				break;
			case "agent_notify":
			case "error":
				showNotice(evt.message);
				break;
		}
	}

	// -------------------------------------------------------------- actions

	const sendText = useCallback(() => {
		const text = textInput.trim();
		if (!text || !wsRef.current) return;
		wsRef.current.send(JSON.stringify({ type: "chat", text, source: "text" }));
		setTextInput("");
	}, [textInput]);

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
			if (!res.ok || !body.ok) {
				showNotice(body.error ?? `voice failed (${res.status})`);
			}
			return;
		}
		try {
			const rec = new VoiceRecorder();
			// throttle: the meter re-renders the whole app — update only on real changes
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
	}, [recording, pairing]);

	// -------------------------------------------------------------- render

	useEffect(() => {
		listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
	}, [bubbles, agentState]);

	if (!pairing) {
		return (
			<div className="setup">
				<pre className="meme">{`   ┌──────┐        ┌──────┐        ┌──────┐
   │ sspi │ ─────► │  *p  │ ─────► │  pi  │
   └──────┘        └──────┘        └──────┘`}</pre>
				<h1>Pair with your omni agent</h1>
				<p>Run the sspi server on your Mac; it prints a pairing token. Secrets never leave the Mac.</p>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						const data = new FormData(e.currentTarget);
						const server = String(data.get("server") ?? "").replace(/\/$/, "");
						const token = String(data.get("token") ?? "").trim();
						if (server && token) {
							localStorage.setItem("sspi.pairing", JSON.stringify({ server, token }));
							setPairing({ server, token });
						}
					}}
				>
					<label>
						Server
						<input name="server" defaultValue={location.origin.includes("5173") ? "http://localhost:8787" : location.origin} required />
					</label>
					<label>
						Pairing token
						<input name="token" placeholder="printed by the server" required autoComplete="off" />
					</label>
					<button type="submit">Connect</button>
				</form>
				{notice && <p className="notice">{notice}</p>}
			</div>
		);
	}

	const statusText =
		!connected
			? "connecting…"
			: agentState === "tool"
				? `running ${toolLabel ?? "tool"}…`
				: agentState === "thinking"
					? "thinking…"
					: agentState === "streaming"
						? "writing…"
						: agentState === "starting"
							? "agent starting…"
							: "";

	return (
		<div className="app">
			<header>
				<span className="logo">
					sspi <em>**pi</em>
				</span>
				<span className={`dot ${connected ? "on" : "off"}`} />
				<span className="status">{statusText || "one session · every screen"}</span>
			</header>

			<div className="list" ref={listRef}>
				{bubbles.length === 0 && (
					<div className="empty">
						<p>Talk to your omni agent.</p>
						<p className="hint">
							It manages your repos, their pi sessions, and worktrees. Press the mic and speak — that's the
							whole point.
						</p>
					</div>
				)}
				{bubbles.map((b) => (
					<div key={b.id} className={`bubble ${b.role} ${b.streaming ? "streaming" : ""}`}>
						{b.source === "voice" && <span className="mic-tag">🎤</span>}
						{b.text || "…"}
					</div>
				))}
				{(agentState === "thinking" || agentState === "tool") && <div className="pulse" />}
			</div>

			{notice && <div className="toast">{notice}</div>}

			<footer>
				<button
					type="button"
					className={`mic ${recording ? "rec" : ""}`}
					style={recording ? ({ "--level": `${Math.min(100, level * 400)}%` } as React.CSSProperties) : undefined}
					onClick={toggleMic}
					aria-label={recording ? "stop and send" : "start recording"}
				>
					{recording ? "■" : "●"}
				</button>
				<div className="composer">
					<input
						value={textInput}
						onChange={(e) => setTextInput(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && sendText()}
						placeholder={recording ? "listening…" : "or type to the omni agent"}
						disabled={recording}
					/>
					<button type="button" onClick={sendText} disabled={!textInput.trim() || recording}>
						send
					</button>
				</div>
			</footer>
		</div>
	);
}
