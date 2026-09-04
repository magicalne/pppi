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

/** A VoiceStt with a streaming utterance: partials grow with each feed, finalize returns the text. */
function fakeStreamingStt(text: string) {
	const rec = { feedCalls: [] as Float32Array[], finalized: 0, disposed: 0 };
	const words = text.split(" ");
	const stt: VoiceStt = {
		status: { ready: true, modelId: "fake-stream" },
		openUtterance: () =>
			Promise.resolve({
				feed: async (pcm: Float32Array) => {
					rec.feedCalls.push(pcm);
					const n = Math.min(rec.feedCalls.length, words.length);
					return {
						committed: words.slice(0, Math.max(0, n - 1)).join(" "),
						tentative: words.slice(Math.max(0, n - 1), n).join(" "),
					};
				},
				finalize: async () => {
					rec.finalized++;
					return text;
				},
				dispose: () => {
					rec.disposed++;
				},
			}),
		transcribeBuffer: () => Promise.resolve(""),
	};
	return { stt, rec };
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
			const onMsg = (raw: Buffer) => {
				let evt: any;
				try {
					evt = JSON.parse(raw.toString()); // binary audio frames are skipped
				} catch {
					return;
				}
				if (!type || evt.type === type) {
					clearTimeout(timer);
					ws.off("message", onMsg);
					resolve(evt);
				}
			};
			ws.on("message", onMsg);
		});
	}

	/** Resolve when `type` arrives, with every event seen until then (snapshotted). */
	function collectUntil(ws: WebSocket, type: string): Promise<any[]> {
		return new Promise((resolve, reject) => {
			const seen: any[] = [];
			const onMsg = (raw: Buffer) => {
				let evt: any;
				try {
					evt = JSON.parse(raw.toString());
				} catch {
					return;
				}
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

	/** A VoiceTts that speaks every request in three small PCM chunks. */
	function fakeTts(opts: { chunkDelayMs?: number } = {}) {
		const received: string[] = [];
		const provider: VoiceTts = {
			status: { ready: true, provider: "fake", voice: "v1" },
			synthesize(text: string) {
				received.push(text);
				return (async function* () {
					for (let i = 0; i < 3; i++) {
						if (opts.chunkDelayMs) await new Promise((r) => setTimeout(r, opts.chunkDelayMs));
						yield { pcm: Buffer.from([0, 0]), rate: 24000 };
					}
				})();
			},
		};
		return { provider, received };
	}

	async function boot(stt: VoiceStt, tts?: VoiceTts, mockReply = "ack from omni"): Promise<void> {
		process.env.MOCK_REPLY = mockReply;
		driver = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
		app = await createServer({ token, driver, stt: Stt.create({ disabled: true }), voiceStt: stt, tts });
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

	it("streams partials and finalizes a streaming utterance in feed order", async () => {
		const { stt, rec } = fakeStreamingStt("what is the status");
		await boot(stt);
		const voice = await voiceConnect(token);
		const hello = await nextEvent(voice, "voice_hello_ok");
		expect(hello.stt.modelId).toBe("fake-stream");

		const partials: Array<{ committed: string; tentative: string }> = [];
		const onPartial = (raw: Buffer) => {
			const evt = JSON.parse(raw.toString()) as any;
			if (evt.type === "stt_partial") partials.push({ committed: evt.committed, tentative: evt.tentative });
		};
		voice.on("message", onPartial);

		voice.send(JSON.stringify({ type: "speech_start" }));
		voice.send(pcmChunk(0.3));
		voice.send(pcmChunk(0.3));
		voice.send(pcmChunk(0.3));
		voice.send(JSON.stringify({ type: "speech_end" }));

		const sttFinal = await nextEvent(voice, "stt_final");
		expect(sttFinal.text).toBe("what is the status");
		await new Promise((r) => setTimeout(r, 100));

		expect(rec.feedCalls.length).toBe(3);
		expect(rec.feedCalls[0]!.length).toBe(rec.feedCalls[1]!.length);
		expect(rec.finalized).toBe(1);
		expect(rec.disposed).toBe(1);
		expect(partials.length).toBe(3);
		expect(partials[0]).toEqual({ committed: "", tentative: "what" });
		expect(partials[2]).toEqual({ committed: "what is", tentative: "the" });

		voice.off("message", onPartial);
		voice.close();
	});

	it("treats a bare control phrase as a command, not a turn", async () => {
		await boot(fakeStt("stop"));
		let aborted = 0;
		driver.abort = async () => {
			aborted++;
		};
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		const chat = await chatConnect();
		await nextEvent(chat, "hello_ok");

		const stray = nextEvent(chat, "transcript");
		voice.send(JSON.stringify({ type: "speech_start" }));
		voice.send(pcmChunk(0.5));
		voice.send(JSON.stringify({ type: "speech_end" }));

		const sttFinal = await nextEvent(voice, "stt_final");
		expect(sttFinal.text).toBe("stop");
		expect(aborted).toBe(1);
		await expect(stray).rejects.toThrow(); // nothing dispatched to the agent
		voice.close();
		chat.close();
	});

	it("dispatches sentences that merely contain a control word", async () => {
		await boot(fakeStt("stop the build"));
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		const chat = await chatConnect();
		await nextEvent(chat, "hello_ok");

		const transcript = nextEvent(chat, "transcript");
		voice.send(JSON.stringify({ type: "speech_start" }));
		voice.send(pcmChunk(0.6));
		voice.send(JSON.stringify({ type: "speech_end" }));
		expect((await transcript).text).toBe("stop the build");
		voice.close();
		chat.close();
	});

	it("speaks the reply sentence by sentence with tts framing", async () => {
		const { provider, received } = fakeTts();
		await boot(fakeStt("say something"), provider, "Hello there. How are you?");
		const voice = await voiceConnect(token);
		const hello = await nextEvent(voice, "voice_hello_ok");
		expect(hello.tts).toEqual({ ready: true, provider: "fake", voice: "v1" });

		// collect everything from speech_start until the last tts_end settles
		const frames: Buffer[] = [];
		const events: any[] = [];
		const onMsg = (raw: Buffer, isBinary: boolean) => {
			if (isBinary) {
				frames.push(raw);
				return;
			}
			events.push(JSON.parse(raw.toString()));
		};
		voice.on("message", onMsg);

		voice.send(JSON.stringify({ type: "speech_start" }));
		voice.send(pcmChunk(0.5));
		voice.send(JSON.stringify({ type: "speech_end" }));
		await nextEvent(voice, "stt_final");
		await new Promise((r) => setTimeout(r, 300));

		const starts = events.filter((e) => e.type === "tts_start");
		const ends = events.filter((e) => e.type === "tts_end");
		expect(received).toEqual(["Hello there.", "How are you?"]);
		expect(starts.length).toBe(2);
		expect(ends.length).toBe(2);
		expect(starts[0]!.rate).toBe(24000);
		expect(starts[0]!.id).not.toBe(starts[1]!.id);
		expect(ends.every((e) => !e.interrupted)).toBe(true);
		const states = events.filter((e) => e.type === "voice_state").map((e) => e.state);
		expect(states).toContain("speaking");
		expect(states.at(-1)).toBe("listening");
		expect(frames.length).toBe(6); // 3 chunks per spoken sentence
		voice.off("message", onMsg);
		voice.close();
	});

	it("keeps code fences out of the spoken prose", async () => {
		const { provider, received } = fakeTts();
		await boot(fakeStt("show me"), provider, "Look. ```js\nlet x = 1\n```\nDone.");
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		voice.send(JSON.stringify({ type: "speech_start" }));
		voice.send(pcmChunk(0.5));
		voice.send(JSON.stringify({ type: "speech_end" }));
		await new Promise((r) => setTimeout(r, 300));

		const spoken = received.join(" | ");
		expect(spoken).toContain("Look.");
		expect(spoken).toContain("Code is on the screen");
		expect(spoken).toContain("Done.");
		expect(spoken).not.toContain("let x");
		expect(spoken).not.toContain("```");
		voice.close();
	});

	it("interrupt stops synthesis mid-sentence and marks the item interrupted", async () => {
		const { provider } = fakeTts({ chunkDelayMs: 60 });
		let aborted = 0;
		await boot(fakeStt("talk"), provider, "a fairly long spoken sentence for the fake voice");
		driver.abort = async () => {
			aborted++;
		};
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");

		voice.send(JSON.stringify({ type: "speech_start" }));
		voice.send(pcmChunk(0.5));
		voice.send(JSON.stringify({ type: "speech_end" }));

		const start = await nextEvent(voice, "tts_start");
		voice.send(JSON.stringify({ type: "interrupt" }));

		const end = await nextEvent(voice, "tts_end");
		expect(end.id).toBe(start.id);
		expect(end.interrupted).toBe(true);
		expect(aborted).toBe(1);
		await new Promise((r) => setTimeout(r, 200));
		voice.close();
	});
});
