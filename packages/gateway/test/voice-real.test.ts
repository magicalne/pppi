// Real end-to-end for dictation with self-interruptions: phrases are
// synthesized with the machine's speech generator (piper / macOS `say` /
// espeak-ng — see test/speech.ts) and streamed through the REAL silero VAD
// and the REAL parakeet STT. Runs on macOS and Linux with the STT model
// present; the barge-in test additionally needs a TTS provider.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RpcAgentDriver } from "../src/agent.ts";
import { createGateway } from "../src/gateway.ts";
import { Stt, resolveSttModel } from "../src/stt.ts";
import { resolveTtsProvider } from "../src/tts.ts";
import { SileroVad } from "../src/vad.ts";
import { speakPcm16k, speechGenerator, transcriptQualityGenerator } from "./speech.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "mock-agent.mjs");

const modelStatus = resolveSttModel();
const gen = speechGenerator();
const supported = modelStatus.ready && transcriptQualityGenerator(gen);

const phrases = [
	"what is the current build status",
	"and also run the unit tests",
	"and then tell me if the deploy is green",
];

/** Poll until fn() is true — dispatches land mid-stream, sleeps race. */
async function until(fn: () => boolean, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Compare transcripts case- and punctuation-insensitively — parakeet adds its own. */
const norm = (s: string): string =>
	s
		.toLowerCase()
		.replace(/[^a-z\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();

describe.skipIf(!supported)("spoken self-interruption (real vad + stt)", () => {
	const token = "voice-real-token";
	let app: Awaited<ReturnType<typeof createGateway>>;
	let driver: RpcAgentDriver;

	afterEach(async () => {
		process.env.MOCK_DELAY = undefined;
		process.env.MOCK_REPLY = undefined;
		process.env.MOCK_DELTA_MS = undefined;
		driver?.dispose();
		if (app) await app.close();
	});

	it(`reads three separately-spoken fragments exactly once (${gen} voice)`, async () => {
		process.env.MOCK_DELAY = "8000"; // the agent stays busy across all three fragments
		process.env.MOCK_REPLY = "ack: {echo}";
		const pcm16s: Buffer[] = [];
		for (const phrase of phrases) {
			pcm16s.push(await speakPcm16k(phrase));
		}

		const vad = await SileroVad.create();
		driver = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
		const prompts: string[] = [];
		{
			const realPrompt = driver.prompt.bind(driver);
			driver.prompt = (text: string) => {
				prompts.push(text);
				return realPrompt(text);
			};
		}
		app = await createGateway({ token, agent: driver, stt: Stt.create(), vad });
		await app.listen(0, "127.0.0.1");
		const addr = app.address();
		const port = typeof addr === "object" && addr?.port ? addr.port : 0;
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));

		const chat = await new Promise<WebSocket>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
			ws.on("open", () => {
				ws.send(JSON.stringify({ type: "hello", token, client: "test" }));
				resolve(ws);
			});
			ws.on("error", reject);
		});
		const userMessages: string[] = [];
		const assistantFinals: string[] = [];
		chat.on("message", (raw) => {
			try {
				const e = JSON.parse(raw.toString()) as any;
				if (e.type === "user_message") userMessages.push(e.text);
				if (e.type === "assistant_final") assistantFinals.push(e.text);
			} catch {
				// binary
			}
		});
		await new Promise((r) => setTimeout(r, 150));

		const voice = await new Promise<WebSocket>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`);
			ws.on("open", () => {
				ws.send(JSON.stringify({ type: "hello", token, client: "test" }));
				resolve(ws);
			});
			ws.on("error", reject);
		});
		await new Promise((r) => setTimeout(r, 200));

		// speak each fragment, then pause long enough (endpoint 0.9s + grace
		// 1.2s) that it dispatches as its own turn while the agent is busy
		const stream = async (data: Buffer): Promise<void> => {
			for (let off = 0; off < data.length; off += 3200) {
				voice.send(data.subarray(off, off + 3200));
				await new Promise((r) => setTimeout(r, 8)); // faster than realtime is fine
			}
		};
		for (const pcm16 of pcm16s) {
			await stream(pcm16);
			await stream(Buffer.alloc(16000 * 2 * 3)); // 3s silence → endpoint + grace expiry
		}

		// the final prompt the agent actually reads must be the WHOLE thought
		await until(() => prompts.length > 0 && norm(prompts.at(-1)!).includes(norm(phrases[2]!)));
		const finalPrompt = norm(prompts.at(-1)!);
		// one stable keyword per fragment (parakeet drops/punctualizes words, so
		// exact-phrase matching would be flaky — same policy as stt.test.ts)
		const keywords = ["status", "tests", "deploy"];
		for (const kw of keywords) {
			expect(finalPrompt.split(kw).length - 1).toBe(1); // each fragment exactly once
		}
		expect(finalPrompt.indexOf(keywords[0]!)).toBeLessThan(finalPrompt.indexOf(keywords[1]!));
		expect(finalPrompt.indexOf(keywords[1]!)).toBeLessThan(finalPrompt.indexOf(keywords[2]!));

		// every fragment was surfaced to clients as it was spoken (parakeet may
		// drop words, so match on count rather than exact text)
		expect(userMessages.length).toBe(phrases.length);
		expect(userMessages.every((m) => m.trim().length > 0)).toBe(true);
		// …and the agent completed exactly one reply for the merged thought
		await until(() => assistantFinals.length >= 1);
		await new Promise((r) => setTimeout(r, 500));
		expect(assistantFinals.length).toBe(1);
		expect(norm(assistantFinals[0]!)).toContain("deploy");

		chat.close();
		voice.close();
	}, 180_000);
});

// The user's loudest requirement: the agent must NEVER keep talking while the
// user is still speaking. This is barge-in with every real model in the loop —
// real silero VAD hearing real (synthesized) speech over real TTS playback,
// real STT turning the interruption into a fresh turn.
const bargeEvents: any[] = [];

async function bargeInBody(
	tts: { synthesize(text: string): AsyncIterable<any>; status: any },
	token: string,
): Promise<void> {
	// a reply long enough that TTS is still speaking when the user barges in
	process.env.MOCK_REPLY =
		"Sure, I can explain the whole build pipeline in detail. First the code is compiled and unit tests run. Then the artifact is staged and integration tests run against it. Finally the deploy rolls out progressively and health checks gate each step.";

	const vad = await SileroVad.create();
	const driver = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
	let aborts = 0;
	{
		const realAbort = driver.abort.bind(driver);
		driver.abort = () => {
			aborts++;
			return realAbort();
		};
	}
	const app = await createGateway({ token, agent: driver, stt: Stt.create(), tts, vad });
	await app.listen(0, "127.0.0.1");
	const port = app.address()?.port ?? 0;
	driver.start();
	await new Promise<void>((r) => driver.once("ready", r));

	const voice = await new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`);
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "hello", token, client: "test" }));
			resolve(ws);
		});
		ws.on("error", reject);
	});
	const events = bargeEvents;
	events.length = 0;
	voice.on("message", (raw, isBinary) => {
		if (isBinary) return;
		events.push(JSON.parse(raw.toString()));
	});
	await until(() => events.some((e) => e.type === "voice_hello_ok"));

	const stream = async (data: Buffer, chunkMs = 100): Promise<void> => {
		// 16 kHz PCM16 = 3200 bytes per 100 ms; paced like a real mic
		for (let off = 0; off < data.length; off += 3200) {
			voice.send(data.subarray(off, off + 3200));
			await new Promise((r) => setTimeout(r, chunkMs));
		}
	};
	const silence = (seconds: number): Buffer => Buffer.alloc(16000 * 2 * seconds);

	// turn 1: "tell me about the build" → silence endpoints it → reply speaks
	await stream(await speakPcm16k("tell me about the build"));
	await stream(silence(3), 200); // endpoint (0.9s) + grace (1.2s) → dispatch
	await until(() => events.some((e) => e.type === "tts_start"), 30_000);

	// the user talks over the agent — barge-in must cut TTS within
	// bargeInMs (250ms) of sustained speech, abort the agent turn, and
	// mark the interrupted playback for the client
	await stream(await speakPcm16k("wait stop I have more to say"));
	await until(() => events.some((e) => e.type === "tts_end" && e.interrupted), 20_000);
	await until(() => aborts >= 1, 10_000);
	expect(aborts).toBeGreaterThanOrEqual(1);

	// …and the interrupting utterance itself becomes the next turn
	await stream(silence(4)); // trailing silence → endpoint + grace
	await until(() => events.filter((e) => e.type === "stt_final").length >= 2, 30_000);
	const finals = events.filter((e) => e.type === "stt_final").map((e) => norm(e.text ?? ""));
	expect(finals.length).toBeGreaterThanOrEqual(2); // the question + the interruption
	expect(finals.at(-1)).toContain("stop");

	voice.close();
	await app.close();
	driver.dispose();
	vad.dispose();
}

describe.skipIf(!supported)("barge-in (real vad + stt + tts)", () => {
	const token = "voice-barge-token";

	afterEach(() => {
		process.env.MOCK_DELAY = undefined;
		process.env.MOCK_REPLY = undefined;
		process.env.MOCK_DELTA_MS = undefined;
	});

	it("stops speaking and aborts the agent the moment the user talks over it", async () => {
		const tts = resolveTtsProvider();
		if (!tts.status.ready) throw new Error(`needs a ready TTS provider (${tts.status.reason})`);
		try {
			await bargeInBody(tts, token);
		} catch (err) {
			// forensics: what did the voice socket actually see?
			console.error("barge-in events:", JSON.stringify(bargeEvents.map((e) => e.type)));
			console.error("barge-in detail:", JSON.stringify(bargeEvents.filter((e) => e.type !== "stt_partial").slice(-14)));
			throw err;
		}
	}, 180_000);
});
