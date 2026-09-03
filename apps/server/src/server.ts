// sspi gateway server.
//
// Owns THE single omni agent session (apps talk to it; they never create
// sessions), transcribes voice locally, and mirrors the conversation to every
// paired client (web, android) over WebSocket. Secrets never leave the machine:
// clients only hold the pairing token; provider keys stay inside pi's auth.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { PeerSession, SessionsResponse, Target } from "@sspi/protocol";
import { RpcAgentDriver } from "./agent.ts";
import { tokensMatch } from "./config.ts";
import { Stt } from "./stt.ts";
import { decodeWav, WavError } from "./wav.ts";
import type { ChatEntry, ClientMessage, PairInfo, ServerEvent } from "@sspi/protocol";
import { listSessions, pigeon, type PigeonSession } from "@sspi/omni/pigeon";
import { loadRegistry } from "@sspi/omni/repos";
import { buildProfiles } from "./profiles.ts";

export type ServerOptions = {
	token: string;
	driver: RpcAgentDriver;
	stt: Stt;
	webDist?: string;
	/** Max voice upload size (default 25 MiB ≈ 26 min of 16 kHz PCM16). */
	maxVoiceBytes?: number;
	/** Pairing facts for this machine; enables GET /api/pair when present. */
	pair?: PairInfo;
};

type AuthedSocket = WebSocket & { authed?: boolean };

async function classify(omniSessionId: string, registryDir?: string): Promise<SessionsResponse> {
	const empty: SessionsResponse = { omniSessionId, projects: [], others: [], profiles: {} };
	const res = await listSessions();
	if (!Array.isArray(res)) return empty;
	const reg = loadRegistry(registryDir);
		const peer = (s: PigeonSession): PeerSession => {
			const wtMatch = s.cwd.includes("/.worktrees/")
				? s.cwd.split("/.worktrees/")[1]?.split("/")[0]
				: undefined;
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
		sessions: res
			.filter((s) => !s.me && (s.cwd === r.path || s.cwd.startsWith(`${r.path}/`)))
			.map(peer),
	}));
	const claimed = new Set(projects.flatMap((p) => p.sessions.map((s) => s.sessionId)));
	const others = res
		.filter((s) => !s.me && !claimed.has(s.sessionId) && s.sessionId !== omniSessionId)
		.map(peer);
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
			// profileId = target session id; clients tint via their profiles map
			const replyId = randomUUID();
			broadcast({
				type: "assistant_final",
				id: replyId,
				text: reply || "(empty reply)",
				target,
				profileId: target,
			});
			peerLog.push({ id: replyId, role: "assistant", text: reply || "(empty reply)", ts: Date.now(), target, profileId: target });
		} else {
			const why = res.stderr.trim().split("\n")[0] || `pigeon exited ${res.code}`;
			broadcast({ type: "error", message: why, target });
		}
	}

	// driver events are always the omni conversation (no target)
	opts.driver.on("state", (state, toolName) => broadcast({ type: "agent_state", state, toolName }));
	opts.driver.on("assistant-delta", (id, delta) => broadcast({ type: "assistant_delta", id, delta }));
	opts.driver.on("assistant-final", (id, text) => broadcast({ type: "assistant_final", id, text }));
	opts.driver.on("tool", (toolName, phase, label) => broadcast({ type: "tool_event", toolName, phase, label }));
	opts.driver.on("notify", (level, message) => broadcast({ type: "agent_notify", level, message }));
	opts.driver.on("error", (message) => broadcast({ type: "error", message }));
	opts.driver.on("info", (info) =>
		broadcast({
			type: "agent_info",
			agent: { ...info, state: opts.driver.state },
		}),
	);

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

	// ---------------------------------------------------------------- rest

	app.addContentTypeParser(/^audio\//, { parseAs: "buffer" }, (_req, body, done) => done(null, body));
	app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

	app.get("/api/health", async () => {
		const status = opts.stt.status;
		return {
			ok: true,
			name: "sspi",
			agent: { ...opts.driver.info, state: opts.driver.state },
			stt: status.ready ? { ready: true, modelId: status.modelId } : { ready: false, reason: status.reason },
		};
	});

	app.post<{ Headers: { authorization?: string; "x-sspi-token"?: string } }>("/api/voice", async (req, reply) => {
		const presented = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? req.headers["x-sspi-token"];
		if (!presented || !tokensMatch(presented, opts.token)) {
			return reply.code(401).send({ ok: false, error: "unauthorized" });
		}
		const sttStatus = opts.stt.status;
		if (!sttStatus.ready) return reply.code(503).send({ ok: false, error: sttStatus.reason });
		const body = req.body as Buffer;
		if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ ok: false, error: "empty body; send a WAV" });

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

	// ---------------------------------------------------------------- websocket

	await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

	app.get("/ws", { websocket: true }, (raw: WebSocket) => {
		const socket = raw as AuthedSocket;
		socket.authed = false;
		let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => socket.close(), 10_000);

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
					const entries = await opts.driver.history();
					history = [...entries, ...peerLog]
						.map((h) => ({ ...h, id: randomUUID() }))
						.sort((a, b) => a.ts - b.ts);
				} catch {
					// keep empty history rather than failing the handshake
				}
				send(socket, { type: "hello_ok", agent: { ...opts.driver.info, state: opts.driver.state }, history });
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

	// ---------------------------------------------------------------- static web app

	if (opts.webDist && existsSync(opts.webDist)) {
		app.register(fastifyStatic, { root: opts.webDist });
	}

	return app;
}
