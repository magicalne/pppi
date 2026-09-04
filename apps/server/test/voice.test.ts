import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RpcAgentDriver } from "../src/agent.ts";
import { createServer } from "../src/server.ts";
import { Stt } from "../src/stt.ts";
import type { VoiceStt } from "../src/voice.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mock-agent.mjs");

/** A VoiceStt that always "hears" the given text (batch path). */
function fakeStt(text: string): VoiceStt {
	return {
		status: { ready: true, modelId: "fake-stt" },
		openUtterance: () => Promise.resolve(null),
		transcribeBuffer: () => Promise.resolve(text),
	};
}

/** `seconds` of 16 kHz PCM16 sine — a stand-in for mic audio. */
function pcmChunk(seconds: number): Buffer {
	const n = Math.round(seconds * 16000);
	const buf = Buffer.alloc(n * 2);
	for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i * 2);
	return buf;
}

describe("interactive voice websocket", () => {
	const token = "voice-test-token";
	let app: Awaited<ReturnType<typeof createServer>>;
	let driver: RpcAgentDriver;
	let base: string;

	function voiceConnect(tokenValue: string | null): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`${base}/voice`);
			ws.on("open", () => {
				ws.send(JSON.stringify({ type: "hello", token: tokenValue, client: "test" }));
				resolve(ws);
			});
			ws.on("error", reject);
		});
	}

	function chatConnect(): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`${base}/ws`);
			ws.on("open", () => {
				ws.send(JSON.stringify({ type: "hello", token, client: "test" }));
				resolve(ws);
			});
			ws.on("error", reject);
		});
	}

	function nextEvent(ws: WebSocket, type?: string): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no ${type ?? "event"} within 10s`)), 10_000);
			ws.on("message", (raw) => {
				const evt = JSON.parse(raw.toString());
				if (!type || evt.type === type) {
					clearTimeout(timer);
					resolve(evt);
				}
			});
		});
	}

	/** Resolve when `type` arrives, with every event seen until then (snapshotted). */
	function collectUntil(ws: WebSocket, type: string): Promise<any[]> {
		return new Promise((resolve, reject) => {
			const seen: any[] = [];
			const onMsg = (raw: Buffer) => {
				const evt = JSON.parse(raw.toString());
				seen.push(evt);
				if (evt.type === type) {
					clearTimeout(timer);
					ws.off("message", onMsg);
					resolve([...seen]);
				}
			};
			const timer = setTimeout(
				() => reject(new Error(`no ${type} within 10s (saw: ${seen.map((s) => s.type).join(",")})`)),
				10_000,
			);
			ws.on("message", onMsg);
		});
	}

	async function boot(stt: VoiceStt): Promise<void> {
		process.env.MOCK_REPLY = "ack from omni";
		driver = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
		app = await createServer({ token, driver, stt: Stt.create({ disabled: true }), voiceStt: stt });
		await app.listen({ port: 0, host: "127.0.0.1" });
		const addr = app.server.address();
		const port = typeof addr === "object" && addr?.port ? addr.port : 0;
		base = `ws://127.0.0.1:${port}`;
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
	}

	afterEach(async () => {
		driver?.dispose();
		if (app) await app.close();
	});

	it("handshakes with the right token and rejects the wrong one", async () => {
		await boot(fakeStt("x"));
		const good = await voiceConnect(token);
		const ok = await nextEvent(good, "voice_hello_ok");
		expect(ok.stt).toEqual({ ready: true, modelId: "fake-stt" });
		expect(ok.tts.ready).toBe(false);
		good.close();

		const bad = await voiceConnect("nope");
		const fail = await nextEvent(bad, "voice_hello_fail");
		expect(fail.error).toMatch(/bad pairing token/);
		await new Promise<void>((r) => bad.on("close", r));
	});

	it("turns a spoken utterance into a chat turn on both sockets", async () => {
		await boot(fakeStt("what's the build status"));
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		const chat = await chatConnect();
		await nextEvent(chat, "hello_ok");

		const transcript = nextEvent(chat, "transcript");
		const final = nextEvent(chat, "assistant_final");

		const states: string[] = [];
		const onState = (raw: Buffer) => {
			const evt = JSON.parse(raw.toString()) as { type: string; state?: string };
			if (evt.type === "voice_state" && evt.state) states.push(evt.state);
		};
		voice.on("message", onState);

		voice.send(JSON.stringify({ type: "speech_start" }));
		voice.send(pcmChunk(0.6));
		voice.send(JSON.stringify({ type: "speech_end" }));

		const sttFinal = await nextEvent(voice, "stt_final");
		expect(sttFinal.text).toBe("what's the build status");

		expect((await transcript).text).toBe("what's the build status");
		expect((await final).text).toBe("ack from omni");
		await new Promise((r) => setTimeout(r, 200));

		// speech_start opens listening; thinking during submit; back to listening (no TTS yet)
		expect(states[0]).toBe("listening");
		expect(states).toContain("thinking");
		expect(states.at(-1)).toBe("listening");
		voice.off("message", onState);
		voice.close();
		chat.close();
	});

	it("ignores blips shorter than the minimum utterance", async () => {
		await boot(fakeStt("cough"));
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");

		const settled = collectUntil(voice, "voice_state");
		voice.send(JSON.stringify({ type: "speech_start" }));
		voice.send(pcmChunk(0.05));
		voice.send(JSON.stringify({ type: "speech_end" }));

		const states = (await settled).filter((e) => e.type === "voice_state").map((e) => e.state);
		expect(states.at(-1)).toBe("listening");
		// give any stray dispatch a moment, then confirm nothing was submitted
		await new Promise((r) => setTimeout(r, 150));
		const events: string[] = [];
		voice.on("message", (raw) => events.push((JSON.parse(raw.toString()) as { type: string }).type));
		await new Promise((r) => setTimeout(r, 100));
		expect(events).not.toContain("stt_final");
		voice.close();
	});

	it("interrupt aborts the agent", async () => {
		await boot(fakeStt("x"));
		let aborted = 0;
		driver.abort = async () => {
			aborted++;
		};
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		voice.send(JSON.stringify({ type: "interrupt" }));
		await new Promise((r) => setTimeout(r, 100));
		expect(aborted).toBe(1);
		voice.close();
	});

	it("mirrors voice_active to chat clients while a mic session is open", async () => {
		await boot(fakeStt("x"));
		const chat = await chatConnect();
		await nextEvent(chat, "hello_ok");
		const active = nextEvent(chat, "voice_active");

		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		expect((await active).active).toBe(true);

		const inactive = nextEvent(chat, "voice_active");
		voice.close();
		await new Promise<void>((r) => voice.on("close", r));
		expect((await inactive).active).toBe(false);
		chat.close();
	});
});
