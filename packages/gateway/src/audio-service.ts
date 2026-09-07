// Audio service child: hosts the voice stack OUTSIDE the gateway host process.
// The cli host runs voice in-process under bun; the /omni extension host spawns
// this child instead, so native STT, silero ONNX and kokoro never load into
// pi's process (kokoro's runtime vs worker threads is a known deadlock, and an
// audio crash must not take the conversation host down).
//
// The gateway proxies /voice frames here; control callbacks multiplex back as
// {"type":"__…"} JSON frames (see audio-proxy.ts). Batch hold-to-talk uploads
// come through POST /transcribe.
//
// Env:
//   PPPI_AUDIO_TOKEN    pairing token (required; VoiceSession auths clients)
//   PPPI_AUDIO_FAKE=1   hermetic test mode: energy-based fake VAD, scripted
//                       streaming STT (MOCK_PHRASE), no TTS, no native deps
//
// Prints one JSON line on stdout when ready:
//   {"port":N,"stt":{…},"tts":{…},"vad":bool}

import { type ServerResponse, createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { Stt } from "./stt.ts";
import { resolveTtsProvider } from "./tts.ts";
import { SileroVad } from "./vad.ts";
import { VoiceSession, type VoiceStt, voiceStt } from "./voice.ts";
import { WavError, decodeWav } from "./wav.ts";

const token = process.env.PPPI_AUDIO_TOKEN ?? "";
const fake = process.env.PPPI_AUDIO_FAKE === "1";

function json(res: ServerResponse, code: number, body: unknown): void {
	const line = JSON.stringify(body);
	res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(line) });
	res.end(line);
}

// In fake mode everything must load without native modules: a scripted
// streaming STT that reveals MOCK_PHRASE word by word, and a VAD that reads
// window energy (loud sine ≈ speech) so tests drive turn-taking naturally.
const fakeStt: VoiceStt | null = fake
	? {
			status: { ready: true, modelId: "fake-stream" },
			openUtterance: async () => {
				const words = (process.env.MOCK_PHRASE ?? "mock phrase").split(" ");
				let feeds = 0;
				return {
					feed: async () => {
						feeds++;
						const n = Math.min(feeds, words.length);
						return {
							committed: words.slice(0, Math.max(0, n - 1)).join(" "),
							tentative: words.slice(Math.max(0, n - 1), n).join(" "),
						};
					},
					finalize: async () => words.join(" "),
					dispose: () => {},
				};
			},
			transcribeBuffer: () => Promise.resolve(""),
		}
	: null;

const realStt = fake || process.env.PPPI_AUDIO_NO_STT === "1" ? null : Stt.create({});
const sttPort: VoiceStt = fakeStt ?? voiceStt(realStt!);
const tts = fake ? null : resolveTtsProvider();
const vad = fake
	? { prob: async (window: Float32Array) => (rms(window) > 0.08 ? 0.95 : 0.02) } // windows are float −1…1
	: await SileroVad.create().catch(() => null);

function rms(window: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < window.length; i++) sum += (window[i] ?? 0) ** 2;
	return Math.sqrt(sum / Math.max(1, window.length));
}

const server = createServer((req, res) => {
	if (req.method === "POST" && new URL(req.url ?? "/", "http://local").pathname === "/transcribe") {
		if (!realStt)
			return json(res, 503, { ok: false, error: realStt === null && fake ? "fake mode" : "stt unavailable" });
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", async () => {
			const body = Buffer.concat(chunks);
			if (!token || req.headers.authorization?.replace(/^Bearer\s+/i, "") !== token) {
				return json(res, 401, { ok: false, error: "unauthorized" });
			}
			try {
				const transcript = await realStt.transcribe(decodeWav(body));
				return json(res, 200, { ok: true, transcript });
			} catch (err) {
				if (err instanceof WavError) return json(res, 400, { ok: false, error: err.message });
				return json(res, 500, { ok: false, error: String((err as Error).message ?? err) });
			}
		});
		return;
	}
	json(res, 404, { ok: false, error: "not found" });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
let open = 0;
server.on("upgrade", (req, socket, head) => {
	if (new URL(req.url ?? "/", "http://local").pathname !== "/voice") return socket.destroy();
	wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
		open++;
		void new VoiceSession(ws, {
			token,
			stt: sttPort,
			tts,
			vad: vad ?? { prob: async () => 0 },
			submit: async (text) => ws.send(JSON.stringify({ type: "__submit__", text })),
			abortAgent: () => ws.send(JSON.stringify({ type: "__abort__" })),
			onAuthed: () => ws.send(JSON.stringify({ type: "__voice_active__", active: true })),
			onClosed: () => {
				open = Math.max(0, open - 1);
				if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "__voice_active__", active: open > 0 }));
			},
		});
	});
});

server.listen(0, "127.0.0.1", () => {
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	process.stdout.write(
		`${JSON.stringify({
			port,
			stt: sttPort.status,
			tts: tts?.status ?? { ready: false, reason: fake ? "fake mode" : "unavailable" },
			vad: vad !== null,
		})}\n`,
	);
});
