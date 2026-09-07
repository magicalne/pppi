// pppi gateway server.
//
// Owns THE single omni agent session (apps talk to it; they never create
// sessions), transcribes voice locally, and mirrors the conversation to every
// paired client (web, android) over WebSocket. Secrets never leave the machine:
// clients only hold the pairing token; provider keys stay inside pi's auth.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
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
import fastify, { type FastifyInstance } from "fastify";
import { minimatch } from "minimatch";
import type { WebSocket } from "ws";
import type { RpcAgentDriver } from "./agent.ts";
import { tokensMatch } from "./config.ts";
import { buildProfiles } from "./profiles.ts";
import type { Stt } from "./stt.ts";
import { SileroVad, type VadTimings } from "./vad.ts";
import { VoiceSession, type VoiceStt, type VoiceTts, voiceStt } from "./voice.ts";
import { WavError, decodeWav } from "./wav.ts";

export type ServerOptions = {
	token: string;
	driver: RpcAgentDriver;
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
	/** Voice-activity model (tests); defaults to the bundled silero_vad.onnx, inert if missing. */
	vad?: SileroVad;
	/** Turn-taking timings override (tests); defaults are the tuned plan values. */
	voiceTimings?: Partial<VadTimings>;
	/** Enabled-model patterns override (tests); default reads pi's settings (global + project). */
	enabledModelsProvider?: () => string[] | undefined;
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

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
	const app = fastify({ logger: false, bodyLimit: opts.maxVoiceBytes ?? 25 * 1024 * 1024 }) as FastifyInstance;

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

	// driver events are always the omni conversation (no target).
	// They also feed interactive voice: open mic sessions speak the answer.
	const speakAssistant = (fn: (s: VoiceSession) => void): void => {
		for (const s of voiceSessions) fn(s);
	};
	// the wire AgentInfo keeps `model` as a display string; full model facts
	// travel in `status` (below)
	const agentInfo = (): AgentInfo => {
		const info = opts.driver.info;
		return {
			model: info.model ? `${info.model.provider}/${info.model.id}` : null,
			sessionName: info.sessionName,
			sessionId: info.sessionId,
			state: opts.driver.state,
		};
	};

	opts.driver.on("state", (state, toolName) => broadcast({ type: "agent_state", state, toolName }));
	opts.driver.on("status", (status) => broadcast({ type: "status", status }));
	opts.driver.on("assistant-delta", (id, delta) => {
		broadcast({ type: "assistant_delta", id, delta });
		speakAssistant((s) => s.assistantDelta(id, delta));
	});
	opts.driver.on("assistant-final", (id, text) => {
		broadcast({ type: "assistant_final", id, text });
		speakAssistant((s) => s.assistantFinal(id, text));
	});
	opts.driver.on("tool", (toolName, phase, label) => broadcast({ type: "tool_event", toolName, phase, label }));
	opts.driver.on("notify", (level, message) => broadcast({ type: "agent_notify", level, message }));
	opts.driver.on("error", (message) => broadcast({ type: "error", message }));
	opts.driver.on("info", () => broadcast({ type: "agent_info", agent: agentInfo() }));

	// Poll the omni session's pigeon mailbox: whenever a delegated peer answers,
	// surface the reply into the omni conversation with the peer's profileId so
	// clients render it in that agent's color. --keep leaves the entries for the
	// omni's own omni_replies; seen msgIds prevent re-broadcasts.
	const seenReplies = new Set<string>();
	const mailboxPoll = setInterval(async () => {
		if (clients.size === 0) return;
		const res = await pigeon(["replies", "--json", "--keep", "--timeout", "1"], {
			sessionId: opts.driver.info.sessionId,
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
	void mailboxPoll;

	async function submitUserText(text: string, source: "voice" | "text", target?: Target): Promise<{ id: string }> {
		const id = randomUUID();
		if (!target || target === opts.driver.info.sessionId) {
			if (source === "voice") broadcast({ type: "transcript", id, text });
			broadcast({ type: "user_message", id, text, source });
			await opts.driver.prompt(text);
			return { id };
		}
		await sendToPeer(text, target);
		return { id };
	}

	/** Available models filtered by pi's enabledModels settings — the model popup's list. */
	async function listModels(): Promise<void> {
		const models = await opts.driver.availableModels();
		const patterns = opts.enabledModelsProvider ? opts.enabledModelsProvider() : enabledPatternsFromPi(opts.driver.cwd);
		const filtered = patterns?.length
			? models.filter((m) => patterns.some((p) => matchesEnabledPattern(m, p)))
			: models;
		broadcast({ type: "model_list", models: filtered });
	}

	// ---------------------------------------------------------------- rest

	app.addContentTypeParser(/^audio\//, { parseAs: "buffer" }, (_req, body, done) => done(null, body));
	app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

	app.get("/api/health", async () => {
		const status = opts.stt.status;
		return {
			ok: true,
			name: "pppi",
			agent: agentInfo(),
			stt: status.ready ? { ready: true, modelId: status.modelId } : { ready: false, reason: status.reason },
		};
	});

	app.post<{ Headers: { authorization?: string; "x-pppi-token"?: string } }>("/api/voice", async (req, reply) => {
		const presented = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? req.headers["x-pppi-token"];
		if (!presented || !tokensMatch(presented, opts.token)) {
			return reply.code(401).send({ ok: false, error: "unauthorized" });
		}
		const sttStatus = opts.stt.status;
		if (!sttStatus.ready) return reply.code(503).send({ ok: false, error: sttStatus.reason });
		const body = req.body as Buffer;
		if (!Buffer.isBuffer(body) || body.length === 0)
			return reply.code(400).send({ ok: false, error: "empty body; send a WAV" });

		let transcript: string;
		try {
			transcript = await opts.stt.transcribe(decodeWav(body));
		} catch (err) {
			if (err instanceof WavError) return reply.code(400).send({ ok: false, error: err.message });
			throw err;
		}
		if (!transcript) return reply.code(422).send({ ok: false, error: "transcript was empty — say something?" });

		const { id } = await submitUserText(transcript, "voice");
		return { ok: true, id, transcript };
	});

	app.get("/api/sessions", async () => {
		const omniId = opts.driver.info.sessionId ?? "omni";
		if (sessionsCache && Date.now() - sessionsCache.at < 3_000) return sessionsCache.data;
		const data = await classify(omniId);
		sessionsCache = { at: Date.now(), data };
		return data;
	});

	// pairing facts for this machine — token-authed (the token IS the secret,
	// this endpoint only helps already-paired clients learn the machine's name/urls)
	app.get("/api/pair", async (req, reply) => {
		if (!opts.pair) return reply.code(404).send({ ok: false, error: "pairing info unavailable" });
		const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
		if (!tokensMatch(auth, opts.token)) return reply.code(401).send({ ok: false, error: "bad token" });
		return { ok: true, ...opts.pair };
	});

	// the omni extension calls this when it collects a delegated peer's reply
	// (omni_replies): the answer is surfaced into the omni conversation with the
	// peer's profileId, so clients render it in that agent's color
	app.post("/api/peer-reply", async (req, reply) => {
		const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
		if (!tokensMatch(auth, opts.token)) return reply.code(401).send({ ok: false, error: "bad token" });
		const body = req.body as { session?: string; text?: string };
		const session = (body.session ?? "").trim();
		const replyText = (body.text ?? "").trim();
		if (!session || !replyText) return reply.code(400).send({ ok: false, error: "session and text are required" });
		const id = randomUUID();
		broadcast({ type: "assistant_final", id, text: replyText, profileId: session });
		peerLog.push({ id, role: "assistant", text: replyText, ts: Date.now(), profileId: session });
		return { ok: true };
	});

	// ---------------------------------------------------------------- websocket

	await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

	app.get("/ws", { websocket: true }, (raw: WebSocket) => {
		const socket = raw as AuthedSocket;
		socket.authed = false;
		const helloTimer: NodeJS.Timeout | undefined = setTimeout(() => socket.close(), 10_000);

		socket.on("message", async (raw: Buffer) => {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(raw.toString()) as ClientMessage;
			} catch {
				return;
			}
			if (!socket.authed) {
				if (msg.type !== "hello") return socket.close();
				clearTimeout(helloTimer);
				if (!tokensMatch(msg.token ?? "", opts.token)) {
					send(socket, { type: "hello_fail", error: "bad pairing token" });
					return socket.close();
				}
				socket.authed = true;
				clients.add(socket);
				let history: ChatEntry[] = [];
				try {
					// recent window only — clients pull older pages on demand (history)
					const { entries } = await opts.driver.history({ limit: 50 });
					history = [...entries, ...peerLog]
						.map((h) => ({ ...h, id: randomUUID() }))
						.sort((a, b) => a.ts - b.ts)
						.slice(-50);
				} catch {
					// keep empty history rather than failing the handshake
				}
				send(socket, { type: "hello_ok", agent: agentInfo(), history });
				// status-bar snapshot for this client (fresh ones arrive via broadcast)
				send(socket, { type: "status", status: opts.driver.status });
				return;
			}
			if (msg.type === "chat") {
				const text = (msg.text ?? "").trim();
				if (text) {
					submitUserText(text, msg.source ?? "text", msg.target).catch((err) =>
						send(socket, { type: "error", message: String(err.message ?? err), target: msg.target }),
					);
				}
			} else if (msg.type === "abort") {
				opts.driver.abort();
			} else if (msg.type === "set_model") {
				opts.driver
					.setModel(String(msg.provider ?? ""), String(msg.modelId ?? ""))
					.catch((err) => send(socket, { type: "error", message: String(err.message ?? err) }));
			} else if (msg.type === "set_thinking_level") {
				opts.driver
					.setThinkingLevel(String(msg.level ?? ""))
					.catch((err) => send(socket, { type: "error", message: String(err.message ?? err) }));
			} else if (msg.type === "list_models") {
				listModels().catch((err) => send(socket, { type: "error", message: String(err.message ?? err) }));
			} else if (msg.type === "history") {
				// forced older-history load (user scrolled to the top); reply to this socket only
				(async () => {
					const { entries, hasMore } = await opts.driver.history({
						before: typeof msg.before === "number" ? msg.before : undefined,
						limit: typeof msg.limit === "number" ? msg.limit : 50,
					});
					send(socket, {
						type: "history_page",
						entries: entries.map((h) => ({ ...h, id: randomUUID() })),
						hasMore,
					});
				})().catch((err) => send(socket, { type: "error", message: String(err.message ?? err) }));
			}
		});

		socket.on("close", () => {
			clearTimeout(helloTimer);
			clients.delete(socket);
		});
		socket.on("error", () => {
			clearTimeout(helloTimer);
			clients.delete(socket);
		});
	});

	function send(ws: WebSocket, evt: ServerEvent): void {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(evt));
	}

	// ------------------------------------------------------- interactive voice

	const sttPort = opts.voiceStt ?? voiceStt(opts.stt);
	// bundled silero model; a missing file leaves voice sessions connected but inert
	const vad = opts.vad ?? (await SileroVad.create().catch(() => null));
	const voiceSessions = new Set<VoiceSession>();
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

	const inertVad = { prob: async () => 0 };
	app.get("/voice", { websocket: true }, (raw: WebSocket) => {
		const session = new VoiceSession(raw, {
			token: opts.token,
			stt: sttPort,
			tts: opts.tts ?? null,
			vad: vad ?? inertVad,
			timings: opts.voiceTimings,
			submit: (text) => submitUserText(text, "voice"),
			abortAgent: () => void opts.driver.abort(),
			onAuthed: () => setVoiceActive(true),
			onClosed: () => {
				voiceSessions.delete(session);
				setVoiceActive(false);
			},
		});
		voiceSessions.add(session);
	});

	// ---------------------------------------------------------------- static web app

	if (opts.webDist && existsSync(opts.webDist)) {
		app.register(fastifyStatic, { root: opts.webDist });
	}

	return app;
}
