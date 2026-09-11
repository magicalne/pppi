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
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
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
import { AudioService } from "./audio-proxy.ts";
import { tokensMatch } from "./config.ts";
import { buildProfiles } from "./profiles.ts";
import type { Stt } from "./stt.ts";
import { SileroVad, type VadTimings } from "./vad.ts";
import { VoiceSession, type VoiceStt, type VoiceTts, voiceStt } from "./voice.ts";
import { WavError, decodeWav } from "./wav.ts";

export type GatewayOptions = {
	token: string;
	agent: AgentPort;
	/** In-process STT (cli host). Exactly one of `stt` / `audioService` should be set. */
	stt?: Stt;
	/** Serve voice from a spawned audio-service child (extension host): native
	 *  STT, silero and kokoro stay out of pi's process. */
	audioService?: { command: string[]; env?: Record<string, string | undefined> };
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
	/** STT finalize hang budget (tests); default 12s before falling back to batch. */
	voiceFinalizeTimeoutMs?: number;
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

/**
 * The install stamp install.mjs writes next to the gateway runtime — lets
 * clients (and humans) see WHICH build the live gateway is running, so a stale
 * `install:ext` copy can't silently masquerade as the repo's fixes.
 * "dev" when the gateway runs from a plain repo checkout.
 */
function gatewayVersion(): { version: string; packagedAt?: string } {
	try {
		// installed layout: <ext>/node_modules/@pppi/gateway/src/ → ×4 = <ext>/
		const stampPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "version.json");
		const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as { sha?: string; packagedAt?: string };
		return { version: stamp.sha ?? "unknown", packagedAt: stamp.packagedAt };
	} catch {
		return { version: "dev" };
	}
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

/**
 * Read enabledModels from pi's settings (global + project), the same fields
 * pi's own model picker filters by. Read directly rather than through
 * pi-coding-agent: the gateway also runs inside extension copies where the
 * host's module aliasing isn't available.
 */
function enabledPatternsFromPi(cwd: string): string[] | undefined {
	const read = (p: string): { enabledModels?: unknown } | undefined => {
		try {
			return JSON.parse(readFileSync(p, "utf8")) as { enabledModels?: unknown };
		} catch {
			return undefined;
		}
	};
	const global = read(join(homedir(), ".pi", "agent", "settings.json"));
	const project = read(join(cwd, ".pi", "settings.json"));
	const merged = [
		...(Array.isArray(global?.enabledModels) ? (global!.enabledModels as unknown[]) : []),
		...(Array.isArray(project?.enabledModels) ? (project!.enabledModels as unknown[]) : []),
	].filter((p): p is string => typeof p === "string");
	return merged.length > 0 ? merged : undefined;
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

// static-host clients (GitHub Pages) are cross-origin to the gateway; every
// authed route requires the bearer token anyway, so permissive CORS is safe
const CORS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "authorization, content-type, x-pppi-token",
	"access-control-max-age": "86400",
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
	res.writeHead(code, { ...CORS, "content-type": "application/json", "content-length": Buffer.byteLength(line) });
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
	// voice sessions live in-process (cli host) or in the audio child (ext host)
	let voiceSessions: Map<VoiceSession, WebSocket> | null = null;
	let onVoiceSocket: (raw: WebSocket) => void = (raw) => raw.close();

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
	// They also feed interactive voice: open mic sessions speak the answer —
	// in-process sessions directly, or via control frames to the audio child.
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
	const audio = opts.audioService
		? new AudioService({
				command: opts.audioService.command,
				token: opts.token,
				env: opts.audioService.env,
				submit: async (text) => {
					await submitUserText(text, "voice");
				},
				abortAgent: () => void agent.abort(),
				setVoiceActive,
			})
		: null;
	// bring the child up right away so /api/health reflects real voice readiness
	void audio?.ensure();
	// in-process voice: warm the heavy models at boot too, and expose the stage
	// so clients can show "warming up" instead of a silent wait
	let inProcessBoot: { stage: "starting" | "ready" } | null = opts.stt ? { stage: "starting" } : null;
	if (opts.stt) {
		void opts.stt
			.warm()
			.catch(() => undefined)
			.finally(() => {
				inProcessBoot = { stage: "ready" };
			});
		const ttsProvider = opts.tts as { warm?: () => Promise<boolean> } | null | undefined;
		if (ttsProvider && typeof ttsProvider.warm === "function") void ttsProvider.warm().catch(() => {});
	}
	const speakAssistant = (fn: (s: VoiceSession) => void, toChild?: (a: AudioService) => void): void => {
		if (audio) {
			if (toChild) toChild(audio);
			return;
		}
		for (const s of voiceSessions?.keys() ?? []) fn(s);
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

	// ---- voice turn coalescing ------------------------------------------------
	// Dictation produces several dispatched fragments while the agent is still
	// working on the first one. The agent must read the WHOLE thought, exactly
	// once: a fragment landing while a voice turn has NOT yet replied aborts
	// that turn and folds its text into a pending merge, flushed as one prompt
	// when the agent settles. Turns the agent already replied to are consumed —
	// their content is never re-sent, so nothing duplicates.
	let pendingVoiceText: string | null = null;
	let voiceInFlight: { text: string; replied: boolean } | null = null;
	let flushTimer: NodeJS.Timeout | undefined;
	const joinThought = (a: string | null, b: string): string => (a ? `${a} ${b}` : b);
	const flushPendingVoice = (): void => {
		clearTimeout(flushTimer);
		const text = pendingVoiceText;
		if (!text) return;
		pendingVoiceText = null;
		voiceInFlight = { text, replied: false };
		agent.prompt(text).catch((err) => console.error(`[voice] merged turn failed: ${String(err)}`));
	};
	const foldVoiceFragment = (text: string): void => {
		if (voiceInFlight && !voiceInFlight.replied) {
			// the agent hasn't said anything yet — cut it and fold the thought in
			void agent.abort();
			pendingVoiceText = joinThought(pendingVoiceText, voiceInFlight.text);
			voiceInFlight = null;
		}
		pendingVoiceText = joinThought(pendingVoiceText, text);
		// the idle-edge flush usually fires when the agent settles — but state
		// transitions can be suppressed (already idle), so a fold must never
		// depend on that edge alone: short-debounce fallback while idle
		if (agent.state === "idle") {
			clearTimeout(flushTimer);
			flushTimer = setTimeout(() => flushPendingVoice(), 400);
		}
	};

	agent.on("state", (state, toolName) => {
		broadcast({ type: "agent_state", state, toolName });
		if (state === "idle") flushPendingVoice();
	});
	agent.on("status", (status) => broadcast({ type: "status", status }));
	agent.on("assistant-delta", (id: string, delta: string) => {
		if (voiceInFlight) voiceInFlight.replied = true; // the agent is talking — never fold this turn away
		broadcast({ type: "assistant_delta", id, delta });
		speakAssistant(
			(s) => s.assistantDelta(id, delta),
			(a) => a.assistantDelta(id, delta),
		);
	});
	let lastReply: string | null = null;
	agent.on("assistant-final", (id: string, text: string) => {
		if (voiceInFlight) voiceInFlight.replied = true;
		lastReply = text;
		broadcast({ type: "assistant_final", id, text });
		speakAssistant(
			(s) => s.assistantFinal(id, text),
			(a) => a.assistantFinal(id, text),
		);
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
			// session commands ride any client's composer; peers get plain text
			if (await handleSessionCommand(text)) return { id };
			if (source === "voice") broadcast({ type: "transcript", id, text });
			broadcast({ type: "user_message", id, text, source });
			// appended speech while the agent works coalesces (see the block above)
			if (source === "voice" && (agent.state !== "idle" || voiceInFlight)) {
				foldVoiceFragment(text);
				return { id };
			}
			if (source === "voice") voiceInFlight = { text, replied: false };
			await agent.prompt(text);
			return { id };
		}
		await sendToPeer(text, target);
		return { id };
	}

	/** `/new` and `/compact` — false when the text is not a session command. */
	async function handleSessionCommand(text: string): Promise<boolean> {
		const command = text.trim().toLowerCase();
		if (command !== "/new" && command !== "/compact") return false;
		if (agent.state !== "idle") {
			broadcast({ type: "agent_notify", level: "warning", message: "the agent is still working — stop it first" });
			return true;
		}
		try {
			if (command === "/new") {
				broadcast({ type: "agent_notify", level: "info", message: "starting a fresh session…" });
				await agent.newSession();
				broadcast({ type: "session_new" });
				broadcast({ type: "agent_notify", level: "info", message: "fresh session ready" });
			} else {
				broadcast({ type: "agent_notify", level: "info", message: "compacting the session…" });
				await agent.compact();
				broadcast({ type: "agent_notify", level: "info", message: "session compacted — context freed" });
			}
		} catch (err) {
			broadcast({ type: "error", message: (err as Error).message ?? "session command failed" });
		}
		return true;
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
		if (req.method === "OPTIONS") {
			// preflight for cross-origin clients (GitHub Pages → LAN gateway)
			res.writeHead(204, CORS);
			res.end();
			return;
		}
		const path = new URL(req.url ?? "/", "http://local").pathname;
		if (req.method === "GET" && path === "/api/health") {
			// kick the child so a crashed/starting audio service self-heals
			void audio?.ensure();
			const status = audio ? audio.health().stt : (opts.stt?.status ?? { ready: false, reason: "no stt configured" });
			return json(res, 200, {
				ok: true,
				name: "pppi",
				gateway: gatewayVersion(),
				agent: agentInfo(),
				stt: status.ready ? { ready: true, modelId: status.modelId } : { ready: false, reason: status.reason },
				boot: audio ? audio.health().boot : (inProcessBoot ?? { stage: "unavailable", reason: "no voice configured" }),
			});
		}
		if (req.method === "POST" && path === "/api/voice") {
			const presented = bearer(req);
			if (!presented || !tokensMatch(presented, opts.token)) {
				return json(res, 401, { ok: false, error: "unauthorized" });
			}
			const sttStatus = audio
				? audio.health().stt
				: (opts.stt?.status ?? { ready: false, reason: "no stt configured" });
			if (!sttStatus.ready) return json(res, 503, { ok: false, error: sttStatus.reason });
			if (voiceActiveCount > 0) {
				// the native STT model is single-threaded: a batch upload must not
				// race an open interactive stream
				return json(res, 503, {
					ok: false,
					error: "interactive voice is live — stop it first, or just talk",
				});
			}
			const body = await readBody(req, maxVoiceBytes);
			if (body.length === 0) return json(res, 400, { ok: false, error: "empty body; send a WAV" });
			let transcript: string;
			try {
				transcript = audio ? await audio.transcribe(body) : await opts.stt!.transcribe(decodeWav(body));
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

	// child mode (extension host): /voice sockets pipe to the audio service
	if (audio) {
		onVoiceSocket = (raw: WebSocket) => void audio.proxyVoice(raw);
	} else {
		// in-process mode (cli host): the whole voice stack lives here
		const sttPort = opts.voiceStt ?? voiceStt(opts.stt!);
		// bundled silero model; a missing file leaves voice sessions connected but inert
		const vad = opts.vad ?? (await SileroVad.create().catch(() => null));
		voiceSessions = new Map<VoiceSession, WebSocket>();
		const sessions = voiceSessions;

		onVoiceSocket = (raw: WebSocket): void => {
			const session = new VoiceSession(raw, {
				token: opts.token,
				stt: sttPort,
				tts: opts.tts ?? null,
				vad: vad ?? { prob: async () => 0 },
				timings: opts.voiceTimings,
				finalizeTimeoutMs: opts.voiceFinalizeTimeoutMs,
				submit: async (text) => {
					await submitUserText(text, "voice");
				},
				abortAgent: () => void agent.abort(),
				lastReply: () => lastReply,
				onAuthed: () => setVoiceActive(true),
				onClosed: () => {
					sessions.delete(session);
					setVoiceActive(false);
				},
			});
			sessions.set(session, raw);
		};
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
			audio?.close();
			// terminate: upgrade sockets aren't tracked by server.close()
			for (const ws of wss.clients) ws.terminate();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
