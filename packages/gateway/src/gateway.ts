// pppi gateway — the transport-agnostic core every host shares (the standalone
// cli, and `/omni` hosting it inside a pi session).
//
// Owns THE single omni agent session (apps talk to it; they never create
// sessions), transcribes voice locally, and mirrors the conversation to every
// paired client (web, android) over WebSocket. Secrets never leave the machine:
// clients only hold the pairing token; provider keys stay inside pi's auth.
//
// Plain node:http + ws (no framework): this package must also run inside a pi
// extension, where only the deps shipped next to it resolve.

import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type PigeonSession, listSessions, pigeon } from "@pppi/omni/pigeon";
import { loadRegistry } from "@pppi/omni/repos";
import type {
	AgentInfo,
	ChatEntry,
	ClientMessage,
	ModelInfo,
	PairInfo,
	PeerSession,
	ServerEvent,
	SessionsResponse,
	Target,
} from "@pppi/protocol";
import { minimatch } from "minimatch";
import { type WebSocket, WebSocketServer } from "ws";
import type { AgentPort } from "./agent.ts";
import { tokensMatch } from "./config.ts";
import { buildProfiles } from "./profiles.ts";
import type { Stt } from "./stt.ts";
import { SileroVad, type VadTimings } from "./vad.ts";
import { VoiceSession, type VoiceStt, type VoiceTts, voiceStt } from "./voice.ts";
import { WavError, decodeWav } from "./wav.ts";

export type GatewayOptions = {
	token: string;
	agent: AgentPort;
	stt: Stt;
	webDist?: string;
	/** Max voice upload size (default 25 MiB ≈ 26 min of 16 kHz PCM16). */
	maxVoiceBytes?: number;
	/** Pairing facts for this machine; enables GET /api/pair when present. */
	pair?: PairInfo;
	/** Interactive-mode STT override (tests); defaults to batch over `stt`. */
	voiceStt?: VoiceStt;
	/** Interactive-mode TTS provider (tests); null/omitted = no spoken replies yet. */
	tts?: VoiceTts | null;
	/** Voice-activity model (tests); defaults to the bundled silero_vad.onnx, inert if missing.
	 *  Structural on purpose — anything with a per-window probability fits (SileroVad in prod). */
	vad?: { prob(window: Float32Array): Promise<number> };
	/** Turn-taking timings override (tests); defaults are the tuned plan values. */
	voiceTimings?: Partial<VadTimings>;
	/** Enabled-model patterns override (tests); default reads pi's settings (global + project). */
	enabledModelsProvider?: () => string[] | undefined;
};

export type Gateway = {
	listen(port: number, host: string): Promise<void>;
	address(): { port: number; host: string } | null;
	close(): Promise<void>;
};

type AuthedSocket = WebSocket & { authed?: boolean };

// pi's canonical thinking ladder (pi-agent-core ThinkingLevel) — pattern
// suffixes like "openai/gpt-5.2:high" are stripped before matching.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function stripLevelSuffix(pattern: string): string {
	const idx = pattern.lastIndexOf(":");
	if (idx === -1) return pattern;
	return THINKING_LEVELS.includes(pattern.slice(idx + 1)) ? pattern.slice(0, idx) : pattern;
}

/** pi's enabledModels semantics: exact `provider/id` or bare `id`, or a glob over either. */
function matchesEnabledPattern(model: ModelInfo, rawPattern: string): boolean {
	const pattern = stripLevelSuffix(rawPattern.trim()).toLowerCase();
	if (!pattern) return false;
	const full = `${model.provider}/${model.id}`.toLowerCase();
	if (/[*?[]/.test(pattern)) {
		return minimatch(full, pattern, { nocase: true }) || minimatch(model.id, pattern, { nocase: true });
	}
	return full === pattern || model.id.toLowerCase() === pattern;
}

/** Read enabledModels from pi's settings the same way pi's own model picker does. */
function enabledPatternsFromPi(cwd: string): string[] | undefined {
	try {
		const patterns = SettingsManager.create(cwd).getEnabledModels();
		return Array.isArray(patterns) && patterns.length > 0 ? patterns.filter((p) => typeof p === "string") : undefined;
	} catch {
		return undefined;
	}
}

async function classify(omniSessionId: string, registryDir?: string): Promise<SessionsResponse> {
	const empty: SessionsResponse = { omniSessionId, projects: [], others: [], profiles: {} };
	const res = await listSessions();
	if (!Array.isArray(res)) return empty;
	const reg = loadRegistry(registryDir);
	const peer = (s: PigeonSession): PeerSession => {
		const wtMatch = s.cwd.includes("/.worktrees/") ? s.cwd.split("/.worktrees/")[1]?.split("/")[0] : undefined;
		return {
			sessionId: s.sessionId,
			name: s.name,
			state: s.state === "idle" ? "idle" : s.state === "unreach" ? "unreachable" : "busy",
			cwd: s.cwd,
			branch: wtMatch ? "worktree" : "main",
			worktree: wtMatch ?? null,
		};
	};
	const projects = reg.repos.map((r) => ({
		name: r.name,
		path: r.path,
		sessions: res.filter((s) => !s.me && (s.cwd === r.path || s.cwd.startsWith(`${r.path}/`))).map(peer),
	}));
	const claimed = new Set(projects.flatMap((p) => p.sessions.map((s) => s.sessionId)));
	const others = res.filter((s) => !s.me && !claimed.has(s.sessionId) && s.sessionId !== omniSessionId).map(peer);
	const all = [...projects.flatMap((p) => p.sessions), ...others];
	const profiles = buildProfiles(
		[...all.map((s) => s.sessionId), omniSessionId],
		[...all.map((s) => ({ id: s.sessionId, name: s.name, cwd: s.cwd }))],
		registryDir,
	);
	return { omniSessionId, projects, others, profiles };
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json",
	".map": "application/json",
	".txt": "text/plain; charset=utf-8",
	".wasm": "application/wasm",
	".woff2": "font/woff2",
};

function bearer(req: IncomingMessage): string | undefined {
	const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
	return auth ?? (req.headers["x-pppi-token"] as string | undefined);
}

function json(res: ServerResponse, code: number, body: unknown): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	const line = JSON.stringify(body);
	res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(line) });
	res.end(line);
}

async function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > cap) throw new Error(`body exceeds ${cap} bytes`);
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

export async function createGateway(opts: GatewayOptions): Promise<Gateway> {
	const maxVoiceBytes = opts.maxVoiceBytes ?? 25 * 1024 * 1024;
	const agent = opts.agent;

	const clients = new Set<AuthedSocket>();
	let sessionsCache: { at: number; data: SessionsResponse } | null = null;
	// peer exchanges (targets + delegated replies) never enter the omni session
	// transcript, so keep them here for reconnecting clients; lost on gateway restart.
	const peerLog: ChatEntry[] = [];

	function broadcast(evt: ServerEvent): void {
		const line = JSON.stringify(evt);
		for (const ws of clients) {
			try {
				if (ws.readyState === ws.OPEN) ws.send(line);
			} catch {
				clients.delete(ws);
			}
		}
	}

	async function sendToPeer(text: string, target: string): Promise<void> {
		const id = randomUUID();
		broadcast({ type: "user_message", id, text, source: "text", target });
		peerLog.push({ id, role: "user", text, source: "text", ts: Date.now(), target });
		// pigeon --wait blocks until the peer session replies (or timeout)
		const res = await pigeon(["send", target, text, "--wait", "--timeout", "120"], {
			timeoutMs: 130_000,
		});
		if (res.code === 0) {
			// stdout: "✉ accepted by X — msg id\n\n<reply text>"
			const reply = res.stdout.split("\n\n").slice(1).join("\n\n").trim();
			// direct 1:1 session: no tint needed there — profile colors attribute
			// delegated work inside the omni conversation (see /api/peer-reply)
			const replyId = randomUUID();
			broadcast({
				type: "assistant_final",
				id: replyId,
				text: reply || "(empty reply)",
				target,
			});
			peerLog.push({ id: replyId, role: "assistant", text: reply || "(empty reply)", ts: Date.now(), target });
		} else {
			const why = res.stderr.trim().split("\n")[0] || `pigeon exited ${res.code}`;
			broadcast({ type: "error", message: why, target });
		}
	}

	// agent events are always the omni conversation (no target).
	// They also feed interactive voice: open mic sessions speak the answer.
	const speakAssistant = (fn: (s: VoiceSession) => void): void => {
		for (const s of voiceSessions.keys()) fn(s);
	};
	// the wire AgentInfo keeps `model` as a display string; full model facts
	// travel in `status` (below)
	const agentInfo = (): AgentInfo => {
		const info = agent.info;
		return {
			model: info.model ? `${info.model.provider}/${info.model.id}` : null,
			sessionName: info.sessionName,
			sessionId: info.sessionId,
			state: agent.state,
		};
	};

	agent.on("state", (state, toolName) => broadcast({ type: "agent_state", state, toolName }));
	agent.on("status", (status) => broadcast({ type: "status", status }));
	agent.on("assistant-delta", (id: string, delta: string) => {
		broadcast({ type: "assistant_delta", id, delta });
		speakAssistant((s) => s.assistantDelta(id, delta));
	});
	agent.on("assistant-final", (id: string, text: string) => {
		broadcast({ type: "assistant_final", id, text });
		speakAssistant((s) => s.assistantFinal(id, text));
	});
	agent.on("tool", (toolName: string, phase: "start" | "end", label?: string) =>
		broadcast({ type: "tool_event", toolName, phase, label }),
	);
	agent.on("notify", (level, message) => broadcast({ type: "agent_notify", level, message }));
	agent.on("error", (message: string) => broadcast({ type: "error", message }));
	agent.on("info", () => broadcast({ type: "agent_info", agent: agentInfo() }));

	// Poll the omni session's pigeon mailbox: whenever a delegated peer answers,
	// surface the reply into the omni conversation with the peer's profileId so
	// clients render it in that agent's color. --keep leaves the entries for the
	// omni's own omni_replies; seen msgIds prevent re-broadcasts.
	const seenReplies = new Set<string>();
	const mailboxPoll = setInterval(async () => {
		if (clients.size === 0) return;
		const res = await pigeon(["replies", "--json", "--keep", "--timeout", "1"], {
			sessionId: agent.info.sessionId,
			timeoutMs: 15_000,
		});
		if (res.code !== 0) return;
		try {
			const entries = JSON.parse(res.stdout) as Array<{
				kind?: string;
				msgId?: string;
				fromSessionId?: string;
				reply?: string;
			}>;
			for (const e of entries) {
				if (e.kind !== "reply" || !e.msgId || !e.fromSessionId || !e.reply) continue;
				if (seenReplies.has(e.msgId)) continue;
				seenReplies.add(e.msgId);
				const id = randomUUID();
				broadcast({ type: "assistant_final", id, text: e.reply, profileId: e.fromSessionId });
				peerLog.push({ id, role: "assistant", text: e.reply, ts: Date.now(), profileId: e.fromSessionId });
				// a delegated answer lands in the omni conversation — say it too
				speakAssistant((s) => s.assistantFinal(id, e.reply!));
			}
		} catch {
			// no replies yet / non-JSON
		}
	}, 3_000);

	async function submitUserText(text: string, source: "voice" | "text", target?: Target): Promise<{ id: string }> {
		const id = randomUUID();
		if (!target || target === agent.info.sessionId) {
			if (source === "voice") broadcast({ type: "transcript", id, text });
			broadcast({ type: "user_message", id, text, source });
			await agent.prompt(text);
			return { id };
		}
		await sendToPeer(text, target);
		return { id };
	}

	/** Available models filtered by pi's enabledModels settings — the model popup's list. */
	async function listModels(): Promise<void> {
		const models = await agent.availableModels();
		const patterns = opts.enabledModelsProvider ? opts.enabledModelsProvider() : enabledPatternsFromPi(agent.cwd);
		const filtered = patterns?.length
			? models.filter((m) => patterns.some((p) => matchesEnabledPattern(m, p)))
			: models;
		broadcast({ type: "model_list", models: filtered });
	}

	// ---------------------------------------------------------------- rest

	const server: Server = createServer((req, res) => {
		void route(req, res).catch(() => json(res, 500, { ok: false, error: "internal error" }));
	});

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", "http://local").pathname;
		if (req.method === "GET" && path === "/api/health") {
			const status = opts.stt.status;
			return json(res, 200, {
				ok: true,
				name: "pppi",
				agent: agentInfo(),
				stt: status.ready ? { ready: true, modelId: status.modelId } : { ready: false, reason: status.reason },
			});
		}
		if (req.method === "POST" && path === "/api/voice") {
			const presented = bearer(req);
			if (!presented || !tokensMatch(presented, opts.token)) {
				return json(res, 401, { ok: false, error: "unauthorized" });
			}
			const sttStatus = opts.stt.status;
			if (!sttStatus.ready) return json(res, 503, { ok: false, error: sttStatus.reason });
			const body = await readBody(req, maxVoiceBytes);
			if (body.length === 0) return json(res, 400, { ok: false, error: "empty body; send a WAV" });
			let transcript: string;
			try {
				transcript = await opts.stt.transcribe(decodeWav(body));
			} catch (err) {
				if (err instanceof WavError) return json(res, 400, { ok: false, error: err.message });
				throw err;
			}
			if (!transcript) return json(res, 422, { ok: false, error: "transcript was empty — say something?" });
			const { id } = await submitUserText(transcript, "voice");
			return json(res, 200, { ok: true, id, transcript });
		}
		if (req.method === "GET" && path === "/api/sessions") {
			const omniId = agent.info.sessionId ?? "omni";
			if (sessionsCache && Date.now() - sessionsCache.at < 3_000) return json(res, 200, sessionsCache.data);
			const data = await classify(omniId);
			sessionsCache = { at: Date.now(), data };
			return json(res, 200, data);
		}
		// pairing facts for this machine — token-authed (the token IS the secret,
		// this endpoint only helps already-paired clients learn the machine's name/urls)
		if (req.method === "GET" && path === "/api/pair") {
			if (!opts.pair) return json(res, 404, { ok: false, error: "pairing info unavailable" });
			const auth = bearer(req);
			if (!auth || !tokensMatch(auth, opts.token)) return json(res, 401, { ok: false, error: "bad token" });
			return json(res, 200, { ok: true, ...opts.pair });
		}
		// the omni extension calls this when it collects a delegated peer's reply
		// (omni_replies): the answer is surfaced into the omni conversation with the
		// peer's profileId, so clients render it in that agent's color
		if (req.method === "POST" && path === "/api/peer-reply") {
			const auth = bearer(req);
			if (!auth || !tokensMatch(auth, opts.token)) return json(res, 401, { ok: false, error: "bad token" });
			const raw = await readBody(req, 1024 * 1024);
			let body: { session?: string; text?: string } = {};
			try {
				body = JSON.parse(raw.toString()) as { session?: string; text?: string };
			} catch {
				return json(res, 400, { ok: false, error: "invalid JSON" });
			}
			const session = (body.session ?? "").trim();
			const replyText = (body.text ?? "").trim();
			if (!session || !replyText) {
				return json(res, 400, { ok: false, error: "session and text are required" });
			}
			const id = randomUUID();
			broadcast({ type: "assistant_final", id, text: replyText, profileId: session });
			peerLog.push({ id, role: "assistant", text: replyText, ts: Date.now(), profileId: session });
			return json(res, 200, { ok: true });
		}
		if (req.method === "GET") return serveStatic(res, path);
		json(res, 404, { ok: false, error: "not found" });
	}

	function serveStatic(res: ServerResponse, path: string): void {
		if (!opts.webDist) {
			json(res, 404, { ok: false, error: "not found" });
			return;
		}
		const root = normalize(opts.webDist);
		const rel = path === "/" ? "/index.html" : path;
		let file = normalize(join(root, rel));
		if (!file.startsWith(root)) {
			json(res, 403, { ok: false, error: "forbidden" });
			return;
		}
		if (!existsSync(file) || !statSync(file).isFile()) {
			// single-page app: extension-less paths fall back to the entry
			if (extname(rel)) {
				json(res, 404, { ok: false, error: "not found" });
				return;
			}
			file = join(root, "index.html");
			if (!existsSync(file)) {
				json(res, 404, { ok: false, error: "not found" });
				return;
			}
		}
		res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
		createReadStream(file).pipe(res);
	}

	// ---------------------------------------------------------------- websocket

	const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	server.on("upgrade", (req, socket, head) => {
		const path = new URL(req.url ?? "/", "http://local").pathname;
		if (path === "/ws") wss.handleUpgrade(req, socket, head, (ws) => onClientSocket(ws));
		else if (path === "/voice") wss.handleUpgrade(req, socket, head, (ws) => onVoiceSocket(ws));
		else socket.destroy();
	});

	function send(ws: WebSocket, evt: ServerEvent): void {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(evt));
	}

	function onClientSocket(socket: WebSocket): void {
		const ws = socket as AuthedSocket;
		ws.authed = false;
		const helloTimer: NodeJS.Timeout | undefined = setTimeout(() => ws.close(), 10_000);

		ws.on("message", async (raw: Buffer) => {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(raw.toString()) as ClientMessage;
			} catch {
				return;
			}
			if (!ws.authed) {
				if (msg.type !== "hello") return ws.close();
				clearTimeout(helloTimer);
				if (!tokensMatch(msg.token ?? "", opts.token)) {
					send(ws, { type: "hello_fail", error: "bad pairing token" });
					return ws.close();
				}
				ws.authed = true;
				clients.add(ws);
				let history: ChatEntry[] = [];
				try {
					// recent window only — clients pull older pages on demand (history)
					const { entries } = await agent.history({ limit: 50 });
					history = [...entries, ...peerLog]
						.map((h) => ({ ...h, id: randomUUID() }))
						.sort((a, b) => a.ts - b.ts)
						.slice(-50);
				} catch {
					// keep empty history rather than failing the handshake
				}
				send(ws, { type: "hello_ok", agent: agentInfo(), history });
				// status-bar snapshot for this client (fresh ones arrive via broadcast)
				send(ws, { type: "status", status: agent.status });
				return;
			}
			if (msg.type === "chat") {
				const text = (msg.text ?? "").trim();
				if (text) {
					submitUserText(text, msg.source ?? "text", msg.target).catch((err) =>
						send(ws, { type: "error", message: String(err.message ?? err), target: msg.target }),
					);
				}
			} else if (msg.type === "abort") {
				void agent.abort();
			} else if (msg.type === "set_model") {
				agent
					.setModel(String(msg.provider ?? ""), String(msg.modelId ?? ""))
					.catch((err) => send(ws, { type: "error", message: String(err.message ?? err) }));
			} else if (msg.type === "set_thinking_level") {
				agent
					.setThinkingLevel(String(msg.level ?? ""))
					.catch((err) => send(ws, { type: "error", message: String(err.message ?? err) }));
			} else if (msg.type === "list_models") {
				listModels().catch((err) => send(ws, { type: "error", message: String(err.message ?? err) }));
			} else if (msg.type === "history") {
				// forced older-history load (user scrolled to the top); reply to this socket only
				(async () => {
					const { entries, hasMore } = await agent.history({
						before: typeof msg.before === "number" ? msg.before : undefined,
						limit: typeof msg.limit === "number" ? msg.limit : 50,
					});
					send(ws, {
						type: "history_page",
						entries: entries.map((h) => ({ ...h, id: randomUUID() })),
						hasMore,
					});
				})().catch((err) => send(ws, { type: "error", message: String(err.message ?? err) }));
			}
		});

		ws.on("close", () => {
			clearTimeout(helloTimer);
			clients.delete(ws);
		});
		ws.on("error", () => {
			clearTimeout(helloTimer);
			clients.delete(ws);
		});
	}

	// ------------------------------------------------------- interactive voice

	const sttPort = opts.voiceStt ?? voiceStt(opts.stt);
	// bundled silero model; a missing file leaves voice sessions connected but inert
	const vad = opts.vad ?? (await SileroVad.create().catch(() => null));
	const voiceSessions = new Map<VoiceSession, WebSocket>();
	let voiceActiveCount = 0;
	let voiceActive = false;
	const setVoiceActive = (active: boolean): void => {
		voiceActiveCount = Math.max(0, voiceActiveCount + (active ? 1 : -1));
		const now = voiceActiveCount > 0;
		if (now !== voiceActive) {
			voiceActive = now;
			broadcast({ type: "voice_active", active: now });
		}
	};

	function onVoiceSocket(raw: WebSocket): void {
		const session = new VoiceSession(raw, {
			token: opts.token,
			stt: sttPort,
			tts: opts.tts ?? null,
			vad: vad ?? { prob: async () => 0 },
			timings: opts.voiceTimings,
			submit: async (text) => {
				await submitUserText(text, "voice");
			},
			abortAgent: () => void agent.abort(),
			onAuthed: () => setVoiceActive(true),
			onClosed: () => {
				voiceSessions.delete(session);
				setVoiceActive(false);
			},
		});
		voiceSessions.set(session, raw);
	}

	// ---------------------------------------------------------------- lifecycle

	return {
		listen(port: number, host: string): Promise<void> {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
					resolve();
				});
			});
		},
		address() {
			const addr = server.address();
			return typeof addr === "object" && addr ? { port: addr.port, host: addr.address } : null;
		},
		close(): Promise<void> {
			clearInterval(mailboxPoll);
			for (const ws of clients) ws.close();
			for (const raw of voiceSessions.values()) raw.close();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
