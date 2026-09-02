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
import { RpcAgentDriver } from "./agent.ts";
import { tokensMatch } from "./config.ts";
import { Stt } from "./stt.ts";
import { decodeWav, WavError } from "./wav.ts";
import type { ChatEntry, ClientMessage, ServerEvent } from "@sspi/protocol";

export type ServerOptions = {
	token: string;
	driver: RpcAgentDriver;
	stt: Stt;
	webDist?: string;
	/** Max voice upload size (default 25 MiB ≈ 26 min of 16 kHz PCM16). */
	maxVoiceBytes?: number;
};

type AuthedSocket = WebSocket & { authed?: boolean };

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
	const app = fastify({ logger: false, bodyLimit: opts.maxVoiceBytes ?? 25 * 1024 * 1024 }) as FastifyInstance;

	const clients = new Set<AuthedSocket>();

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

	// ---------------------------------------------------------------- agent wiring

	opts.driver.on("state", (state, toolName) => broadcast({ type: "agent_state", state, toolName }));
	opts.driver.on("assistant-delta", (id, delta) => broadcast({ type: "assistant_delta", id, delta }));
	opts.driver.on("assistant-final", (id, text) => broadcast({ type: "assistant_final", id, text }));
	opts.driver.on("tool", (toolName, phase) => broadcast({ type: "tool_event", toolName, phase }));
	opts.driver.on("notify", (level, message) => broadcast({ type: "agent_notify", level, message }));
	opts.driver.on("error", (message) => broadcast({ type: "error", message }));
	opts.driver.on("info", (info) =>
		broadcast({
			type: "agent_info",
			agent: { ...info, state: opts.driver.state },
		}),
	);

	async function submitUserText(text: string, source: "voice" | "text"): Promise<{ id: string; transcript?: string }> {
		const id = randomUUID();
		if (source === "voice") broadcast({ type: "transcript", id, text });
		broadcast({ type: "user_message", id, text, source });
		await opts.driver.prompt(text);
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
					history = entries.map((h) => ({ ...h, id: randomUUID() }));
				} catch {
					// keep empty history rather than failing the handshake
				}
				send(socket, { type: "hello_ok", agent: { ...opts.driver.info, state: opts.driver.state }, history });
				return;
			}
			if (msg.type === "chat") {
				const text = (msg.text ?? "").trim();
				if (text) submitUserText(text, msg.source ?? "text").catch((err) => send(socket, { type: "error", message: String(err.message ?? err) }));
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
