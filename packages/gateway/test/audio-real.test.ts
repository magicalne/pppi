// Full-stack E2E for the audio-service child with REAL models on Linux/macOS:
// spawns the child exactly like the /pppi_gateway host does (bun audio-service.ts),
// waits for its boot story + ready line, then drives the production /voice
// protocol end to end — mic speech → real silero VAD turn-taking → real
// parakeet STT → __submit__ control frame → assistant text control frame →
// real TTS audio streamed back → barge-in cuts the playback and aborts the
// agent (__abort__ frame). Skips without bun, the STT model, or a quality
// speech generator (piper / macOS say — see test/speech.ts).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { resolveSttModel } from "../src/stt.ts";
import { speakPcm16k, speechGenerator, transcriptQualityGenerator } from "./speech.ts";

const audioEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "audio-service.ts");

let bunBin: string | null = null;
try {
	bunBin = execFileSync("which", ["bun"], { encoding: "utf8" }).trim() || null;
} catch {
	bunBin = null;
}

const modelStatus = resolveSttModel();
const gen = speechGenerator();
const supported = !!bunBin && modelStatus.ready && transcriptQualityGenerator(gen);

/** Poll until fn() is true. */
async function until(fn: () => boolean, ms = 60_000): Promise<void> {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe.skipIf(!supported)(`audio service child (real models, ${gen} voice)`, () => {
	const token = "audio-real-token";
	let child: ChildProcess;
	let port = 0;
	let ttsReady = false;
	const procEvents: string[] = []; // child stdout/stderr lines, for failure forensics

	beforeAll(async () => {
		child = spawn(bunBin!, [audioEntry], {
			env: { ...process.env, PPPI_AUDIO_TOKEN: token },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (c: Buffer) => procEvents.push(...c.toString().split("\n").filter(Boolean)));
		child.stderr?.on("data", (c: Buffer) => procEvents.push(...c.toString().split("\n").filter(Boolean)));
		// the child prints boot frames then one ready line with the port
		await until(() => procEvents.some((l) => l.includes('"port"')), 120_000);
		const ready = procEvents.find((l) => l.includes('"port"'));
		const info = JSON.parse(ready ?? "{}") as { port?: number; tts?: { ready?: boolean } };
		expect(info.port).toBeGreaterThan(0);
		port = info.port ?? 0;
		ttsReady = info.tts?.ready === true;
	}, 150_000);

	afterAll(() => {
		child?.kill("SIGTERM");
	});

	it("transcribes speech, speaks the reply, and yields to barge-in", async () => {
		const voice = await new Promise<WebSocket>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`);
			ws.on("open", () => {
				ws.send(JSON.stringify({ type: "hello", token, client: "test" }));
				resolve(ws);
			});
			ws.on("error", reject);
		});
		const events: any[] = [];
		let binaryFrames = 0;
		voice.on("message", (raw, isBinary) => {
			if (isBinary) {
				binaryFrames++;
				return;
			}
			events.push(JSON.parse(raw.toString()));
		});
		await until(() => events.some((e) => e.type === "voice_hello_ok"), 30_000);

		const stream = async (data: Buffer, chunkMs = 100): Promise<void> => {
			for (let off = 0; off < data.length; off += 3200) {
				voice.send(data.subarray(off, off + 3200));
				await new Promise((r) => setTimeout(r, chunkMs));
			}
		};

		// ---- turn: real speech → real VAD opens → real STT transcribes
		await stream(await speakPcm16k("what is the current build status"));
		await stream(Buffer.alloc(16000 * 2 * 3)); // endpoint + grace → dispatch
		await until(() => events.some((e) => e.type === "stt_final"), 60_000);
		const final = events.find((e) => e.type === "stt_final")!;
		expect((final.text ?? "").toLowerCase()).toContain("status");
		// the turn left the child as a __submit__ control frame (parent intercepts these in prod)
		await until(() => events.some((e) => e.type === "__submit__"), 10_000);
		expect(events.find((e) => e.type === "__submit__")!.text).toContain("status");

		// ---- reply: assistant text control frames → real TTS audio streams back.
		// Deltas first, then the final — exactly what the gateway proxy sends;
		// the speaker only speaks finals for ids whose deltas it has seen.
		if (!ttsReady) {
			console.warn("no tts provider on this machine — skipping the spoken/barge-in half");
			voice.close();
			return;
		}
		const reply =
			"The build is green and every unit test passed. The integration suite is still running but the deploy is already staged and health checks look good so far.";
		voice.send(JSON.stringify({ type: "__assistant_delta__", id: "reply-1", delta: reply }));
		voice.send(JSON.stringify({ type: "__assistant_final__", id: "reply-1", text: reply }));
		await until(() => events.some((e) => e.type === "tts_start"), 30_000);
		await until(() => binaryFrames > 3, 30_000);

		// ---- barge-in: the user talks over the playback — it must stop NOW
		await stream(await speakPcm16k("wait stop I am not done talking yet"));
		await until(() => events.some((e) => e.type === "tts_end" && e.interrupted), 30_000);
		await until(() => events.some((e) => e.type === "__abort__"), 10_000);

		// …and the interruption itself becomes the next turn
		await stream(Buffer.alloc(16000 * 2 * 4));
		await until(() => events.filter((e) => e.type === "stt_final").length >= 2, 60_000);
		const second = events.filter((e) => e.type === "stt_final")[1]!;
		expect((second.text ?? "").toLowerCase()).toContain("stop");
		voice.close();
	}, 240_000);
});
