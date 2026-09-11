// Real end-to-end for dictation with self-interruptions: three phrases are
// spoken with the macOS `say` CLI and streamed through the REAL silero VAD and
// the REAL parakeet STT, each separated by enough silence that it dispatches
// as its own turn while the agent is still busy with the previous one. The
// gateway must coalesce them so the agent reads the WHOLE thought exactly
// once. Only runs on darwin with the STT model present.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RpcAgentDriver } from "../src/agent.ts";
import { createGateway } from "../src/gateway.ts";
import { Stt, resolveSttModel } from "../src/stt.ts";
import { SileroVad } from "../src/vad.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "mock-agent.mjs");

const supported = process.platform === "darwin";
const modelStatus = resolveSttModel();

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

describe.skipIf(!supported || !modelStatus.ready)("spoken self-interruption (real vad + stt)", () => {
	const token = "voice-real-token";
	let app: Awaited<ReturnType<typeof createGateway>>;
	let driver: RpcAgentDriver;
	let dir: string;

	afterEach(async () => {
		process.env.MOCK_DELAY = undefined;
		process.env.MOCK_REPLY = undefined;
		driver?.dispose();
		if (app) await app.close();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("reads three separately-spoken fragments exactly once", async () => {
		process.env.MOCK_DELAY = "8000"; // the agent stays busy across all three fragments
		process.env.MOCK_REPLY = "ack: {echo}";
		dir = mkdtempSync(join(tmpdir(), "pppi-interrupt-"));
		const wavs: Buffer[] = [];
		for (const phrase of phrases) {
			const wavPath = join(dir, `${wavs.length}.wav`);
			execFileSync("say", ["-o", wavPath, "--data-format=LEI16@16000", phrase]);
			wavs.push(readFileSync(wavPath).subarray(44)); // PCM16 header off
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
		chat.on("message", (raw: Buffer) => {
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
		for (const wav of wavs) {
			await stream(wav);
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
