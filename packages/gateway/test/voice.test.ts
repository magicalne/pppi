import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RpcAgentDriver } from "../src/agent.ts";
import { createGateway } from "../src/gateway.ts";
import { Stt } from "../src/stt.ts";
import type { VoiceStt, VoiceTts } from "../src/voice.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "mock-agent.mjs");

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

/** Scriptable VAD: queued probabilities consumed in window order (0.02 = silence). */
function fakeVad() {
	const queue: number[] = [];
	const rec = { resets: 0 };
	return {
		push: (probs: number[]) => queue.push(...probs),
		prob: async () => queue.shift() ?? 0.02,
		reset: () => {
			rec.resets++;
		},
		rec,
	};
}

/** `seconds` of 16 kHz PCM16 sine — a stand-in for mic audio (100 ms ≈ 3 VAD windows). */
function pcmChunk(seconds: number): Buffer {
	const n = Math.round(seconds * 16000);
	const buf = Buffer.alloc(n * 2);
	for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i * 2);
	return buf;
}

/** Speak/silence for N 100 ms chunks: queue 3 VAD windows per chunk and stream the audio. */
function say(ws: WebSocket, vadState: ReturnType<typeof fakeVad>, mode: "speech" | "silence", chunks: number): void {
	vadState.push(Array.from({ length: chunks * 3 }, () => (mode === "speech" ? 0.95 : 0.02)));
	for (let i = 0; i < chunks; i++) ws.send(pcmChunk(0.1));
}

/** say() with a beat between phases so the server routes each phase's audio before the next. */
async function sayPaced(
	ws: WebSocket,
	vadState: ReturnType<typeof fakeVad>,
	mode: "speech" | "silence",
	chunks: number,
): Promise<void> {
	say(ws, vadState, mode, chunks);
	await new Promise((r) => setTimeout(r, 40));
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

describe("interactive voice websocket", () => {
	const token = "voice-test-token";
	let app: Awaited<ReturnType<typeof createGateway>>;
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

	async function boot(
		stt: VoiceStt,
		tts?: VoiceTts,
		mockReply = "ack from omni",
		finalizeTimeoutMs?: number,
	): Promise<ReturnType<typeof fakeVad>> {
		process.env.MOCK_REPLY = mockReply;
		const v = fakeVad();
		driver = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
		app = await createGateway({
			token,
			agent: driver,
			stt: Stt.create({ disabled: true }),
			voiceStt: stt,
			tts,
			vad: v,
			...(finalizeTimeoutMs ? { voiceFinalizeTimeoutMs: finalizeTimeoutMs } : {}),
		});
		await app.listen(0, "127.0.0.1");
		const addr = app.address();
		const port = typeof addr === "object" && addr?.port ? addr.port : 0;
		base = `ws://127.0.0.1:${port}`;
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		return v;
	}

	afterEach(async () => {
		driver?.dispose();
		if (app) await app.close();
	});

	// ------------------------------------------------------------- handshake

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

	// ---------------------------------------------------------- turn taking

	it("turns a spoken utterance into a chat turn on both sockets", async () => {
		const v = await boot(fakeStt("what's the build status"));
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		const chat = await chatConnect();
		await nextEvent(chat, "hello_ok");

		const transcript = nextEvent(chat, "transcript");
		const final = nextEvent(chat, "assistant_final");

		const states: string[] = [];
		const vadEvents: boolean[] = [];
		voice.on("message", (raw) => {
			try {
				const e = JSON.parse(raw.toString()) as any;
				if (e.type === "voice_state") states.push(e.state);
				if (e.type === "vad") vadEvents.push(e.speaking);
			} catch {
				// binary frames (none without tts)
			}
		});

		say(voice, v, "speech", 8); // ~770 ms of speech
		say(voice, v, "silence", 30); // endpoint + grace expiry

		const sttFinal = await nextEvent(voice, "stt_final");
		expect(sttFinal.text).toBe("what's the build status");
		expect((await transcript).text).toBe("what's the build status");
		expect((await final).text).toBe("ack from omni");
		await new Promise((r) => setTimeout(r, 150));

		expect(vadEvents).toEqual([true, false]);
		expect(states[states.length - 1]).toBe("listening"); // back to listening (no tts)
		voice.close();
		chat.close();
	});

	it("discards blips shorter than the minimum utterance", async () => {
		const v = await boot(fakeStt("cough"));
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");

		const vadEvents: boolean[] = [];
		const events: string[] = [];
		voice.on("message", (raw) => {
			try {
				const e = JSON.parse(raw.toString()) as any;
				if (e.type === "vad") vadEvents.push(e.speaking);
				events.push(e.type as string);
			} catch {
				// binary
			}
		});

		say(voice, v, "speech", 2); // ~190 ms — over start threshold, under min utterance
		say(voice, v, "silence", 30);
		await new Promise((r) => setTimeout(r, 200));

		// the mic opened and closed, but no turn was dispatched
		expect(vadEvents).toEqual([true, false]);
		expect(events).not.toContain("stt_final");
		voice.close();
	});

	it("merges speech that resumes inside the grace window into one turn", async () => {
		const v = await boot(fakeStt("one single thought"));
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		const chat = await chatConnect();
		await nextEvent(chat, "hello_ok");

		const transcript = nextEvent(chat, "transcript");

		say(voice, v, "speech", 6);
		say(voice, v, "silence", 8); // endpoint fires; grace opens
		say(voice, v, "speech", 5); // resumed in time → same turn
		say(voice, v, "silence", 30); // endpoint + grace → dispatch

		const sttFinal = await nextEvent(voice, "stt_final");
		expect(sttFinal.text).toBe("one single thought");
		expect((await transcript).text).toBe("one single thought");
		await new Promise((r) => setTimeout(r, 150));

		const finals: number[] = [];
		voice.on("message", (raw) => {
			try {
				if ((JSON.parse(raw.toString()) as any).type === "stt_final") finals.push(1);
			} catch {
				// binary
			}
		});
		await new Promise((r) => setTimeout(r, 100));
		expect(finals.length).toBe(0); // exactly one turn was dispatched (before this listener)
		voice.close();
		chat.close();
	});

	it("streams partials for a spoken utterance and finalizes once", async () => {
		const { stt, rec } = fakeStreamingStt("what is the status");
		const v = await boot(stt);
		const voice = await voiceConnect(token);
		const hello = await nextEvent(voice, "voice_hello_ok");
		expect(hello.stt.modelId).toBe("fake-stream");

		const partials: Array<{ committed: string; tentative: string }> = [];
		const onPartial = (raw: Buffer) => {
			try {
				const evt = JSON.parse(raw.toString()) as any;
				if (evt.type === "stt_partial") partials.push({ committed: evt.committed, tentative: evt.tentative });
			} catch {
				// binary
			}
		};
		voice.on("message", onPartial);
		const sttFinalPromise = nextEvent(voice, "stt_final");

		await sayPaced(voice, v, "speech", 8);
		await sayPaced(voice, v, "silence", 30);

		const sttFinal = await sttFinalPromise;
		expect(sttFinal.text).toBe("what is the status");
		await new Promise((r) => setTimeout(r, 100));

		expect(rec.feedCalls.length).toBeGreaterThan(8); // pre-roll + speech
		expect(rec.finalized).toBe(1);
		expect(rec.disposed).toBe(1);
		expect(partials.length).toBeGreaterThan(3);
		expect(partials[0]).toEqual({ committed: "", tentative: "what" });

		voice.off("message", onPartial);
		voice.close();
	});

	// --------------------------------------------------- stt failure fallbacks

	it("falls back to a batch transcription when the stt stream dies mid-utterance", async () => {
		const rec = { disposed: 0, batched: 0 };
		const stt: VoiceStt = {
			status: { ready: true, modelId: "fake-dying-stream" },
			openUtterance: () =>
				Promise.resolve({
					feed: async () => {
						throw new Error("native decoder died");
					},
					finalize: async () => {
						throw new Error("finalize on a dead stream");
					},
					dispose: () => {
						rec.disposed++;
					},
				}),
			transcribeBuffer: () => {
				rec.batched++;
				return Promise.resolve("saved by the batch path");
			},
		};
		const v = await boot(stt);
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		// arm both waiters before any audio — frames can arrive in one burst
		const errEvent = nextEvent(voice, "voice_error");
		const sttFinal = nextEvent(voice, "stt_final");

		say(voice, v, "speech", 8);
		say(voice, v, "silence", 30);

		expect((await errEvent).message).toMatch(/stt stream failed/);
		expect((await sttFinal).text).toBe("saved by the batch path");
		await new Promise((r) => setTimeout(r, 100));
		expect(rec.disposed).toBe(1); // the dead stream was released
		expect(rec.batched).toBe(1); // exactly one batch transcription
		voice.close();
	});

	it("gives up on a hung stt finalize and transcribes the recording instead", async () => {
		const rec = { disposed: 0, batched: 0 };
		const stt: VoiceStt = {
			status: { ready: true, modelId: "fake-hung-finalize" },
			openUtterance: () =>
				Promise.resolve({
					feed: async () => ({ committed: "", tentative: "" }),
					finalize: () => new Promise<string>(() => {}), // never resolves
					dispose: () => {
						rec.disposed++;
					},
				}),
			transcribeBuffer: () => {
				rec.batched++;
				return Promise.resolve("rescued from the hang");
			},
		};
		const v = await boot(stt, undefined, "ack from omni", 250);
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		const errEvent = nextEvent(voice, "voice_error");
		const sttFinal = nextEvent(voice, "stt_final");

		say(voice, v, "speech", 8);
		say(voice, v, "silence", 30);

		expect((await errEvent).message).toMatch(/stt stalled/);
		expect((await sttFinal).text).toBe("rescued from the hang");
		await new Promise((r) => setTimeout(r, 100));
		expect(rec.disposed).toBe(1);
		expect(rec.batched).toBe(1);
		voice.close();
	});

	it("treats a bare control phrase as a command, not a turn", async () => {
		const v = await boot(fakeStt("stop"));
		let aborted = 0;
		driver.abort = async () => {
			aborted++;
		};
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		const chat = await chatConnect();
		await nextEvent(chat, "hello_ok");

		const stray = nextEvent(chat, "transcript");
		say(voice, v, "speech", 8);
		say(voice, v, "silence", 30);

		const sttFinal = await nextEvent(voice, "stt_final");
		expect(sttFinal.text).toBe("stop");
		expect(aborted).toBeGreaterThanOrEqual(1);
		await expect(stray).rejects.toThrow(); // nothing dispatched to the agent
		voice.close();
		chat.close();
	});

	it("repeats the last reply on a repeat magic word without a new turn", async () => {
		const { provider, received } = fakeTts();
		let turns = 0;
		driver.prompt = async () => {
			turns++;
		};
		const v = await boot(fakeStt("repeat"), provider, "ignored turn text");
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		const chat = await chatConnect();
		await nextEvent(chat, "hello_ok");

		const events: any[] = [];
		voice.on("message", (raw: Buffer, isBinary: boolean) => {
			if (isBinary) return;
			events.push(JSON.parse(raw.toString()));
		});

		// seed lastReply through a normal agent final (the gateway tracks it even
		// when the speaker's chunker never saw deltas)
		driver.emit("assistant-final", "seed-1", "The build is green.");

		say(voice, v, "speech", 8);
		say(voice, v, "silence", 30);

		await new Promise((r) => setTimeout(r, 400));
		const starts = events.filter((e) => e.type === "tts_start");
		const states = events.filter((e) => e.type === "voice_state").map((e) => e.state);
		expect(turns).toBe(0); // repeat never becomes a model turn
		expect(received).toEqual(["The build is green."]); // spoken exactly once, from the cache
		expect(starts.length).toBe(1);
		expect(states).toContain("speaking");
		voice.close();
		chat.close();
	});

	it("dispatches sentences that merely contain a control word", async () => {
		const v = await boot(fakeStt("stop the build"));
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		const chat = await chatConnect();
		await nextEvent(chat, "hello_ok");

		const transcript = nextEvent(chat, "transcript");
		say(voice, v, "speech", 8);
		say(voice, v, "silence", 30);
		expect((await transcript).text).toBe("stop the build");
		voice.close();
		chat.close();
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

	// ---------------------------------------------------------------- tts

	it("speaks the reply sentence by sentence with tts framing", async () => {
		const { provider, received } = fakeTts();
		const v = await boot(fakeStt("say something"), provider, "Hello there. How are you?");
		const voice = await voiceConnect(token);
		const hello = await nextEvent(voice, "voice_hello_ok");
		expect(hello.tts).toEqual({ ready: true, provider: "fake", voice: "v1" });

		const frames: Buffer[] = [];
		const events: any[] = [];
		voice.on("message", (raw: Buffer, isBinary: boolean) => {
			if (isBinary) {
				frames.push(raw);
				return;
			}
			events.push(JSON.parse(raw.toString()));
		});

		say(voice, v, "speech", 8);
		say(voice, v, "silence", 30);
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
		voice.close();
	});

	it("keeps code fences out of the spoken prose", async () => {
		const { provider, received } = fakeTts();
		const v = await boot(fakeStt("show me"), provider, "Look. ```js\nlet x = 1\n```\nDone.");
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");
		say(voice, v, "speech", 8);
		say(voice, v, "silence", 30);
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
		const v = await boot(fakeStt("talk"), provider, "a fairly long spoken sentence for the fake voice");
		driver.abort = async () => {
			aborted++;
		};
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");

		say(voice, v, "speech", 8);
		say(voice, v, "silence", 30);

		const start = await nextEvent(voice, "tts_start");
		voice.send(JSON.stringify({ type: "interrupt" }));

		const end = await nextEvent(voice, "tts_end");
		expect(end.id).toBe(start.id);
		expect(end.interrupted).toBe(true);
		expect(aborted).toBeGreaterThanOrEqual(1);
		await new Promise((r) => setTimeout(r, 200));
		voice.close();
	});

	it("barge-in: sustained speech while the agent talks aborts synthesis", async () => {
		const { provider } = fakeTts({ chunkDelayMs: 60 });
		let aborted = 0;
		const v = await boot(fakeStt("talk"), provider, "a fairly long spoken sentence for the fake voice");
		driver.abort = async () => {
			aborted++;
		};
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");

		await sayPaced(voice, v, "speech", 8);
		await sayPaced(voice, v, "silence", 30);
		const start = await nextEvent(voice, "tts_start");

		// user talks over the agent: bargeInMs (250ms) of sustained speech must
		// cut the synthesis off — ~1s of speech is ample
		await sayPaced(voice, v, "speech", 10);

		const end = await nextEvent(voice, "tts_end");
		expect(end.id).toBe(start.id);
		expect(end.interrupted).toBe(true);
		expect(aborted).toBeGreaterThanOrEqual(1);
		await new Promise((r) => setTimeout(r, 200));
		voice.close();
	});

	it("cuts the agent off after bargeInMs of speech, not minutes", async () => {
		// regression: barge-in must react to a SHORT burst of speech over the TTS
		const { provider } = fakeTts({ chunkDelayMs: 60 });
		let aborted = 0;
		const v = await boot(fakeStt("talk"), provider, "a fairly long spoken sentence for the fake voice");
		driver.abort = async () => {
			aborted++;
		};
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");

		await sayPaced(voice, v, "speech", 8);
		await sayPaced(voice, v, "silence", 30);
		await nextEvent(voice, "tts_start");

		// exactly ~0.8s of speech: enough for 250ms sustain, impossible to
		// satisfy if barge-in ever drifts back to needing whole seconds
		await sayPaced(voice, v, "speech", 8);

		const end = await nextEvent(voice, "tts_end");
		expect(end.interrupted).toBe(true);
		expect(aborted).toBeGreaterThanOrEqual(1);
		voice.close();
	});

	it("takes a new turn after a spoken reply finishes (playback_done)", async () => {
		// regression: speech after the agent's reply must not be swallowed —
		// the user's report: "after the response is finished, it doesn't seem
		// to process my request when I start to talk again"
		const { provider } = fakeTts();
		const v = await boot(fakeStt("first question"), provider, "one reply sentence.");
		const voice = await voiceConnect(token);
		await nextEvent(voice, "voice_hello_ok");

		// arm both waiters BEFORE the turn: the whole reply bursts in one
		// socket chunk, and ws emits same-chunk messages synchronously — a
		// listener attached after tts_start resolves misses that chunk's tts_end
		const ttsStart = nextEvent(voice, "tts_start");
		const ttsEnd = nextEvent(voice, "tts_end");

		// turn 1 → reply spoken → client's speaker drained
		say(voice, v, "speech", 8);
		say(voice, v, "silence", 30);
		expect((await nextEvent(voice, "stt_final")).text).toBe("first question");
		await ttsStart;
		await ttsEnd;
		voice.send(JSON.stringify({ type: "playback_done" }));
		await new Promise((r) => setTimeout(r, 150));

		// turn 2 must dispatch exactly like the first
		const second = nextEvent(voice, "stt_final");
		say(voice, v, "speech", 8);
		say(voice, v, "silence", 30);
		expect((await second).text).toBe("first question");

		// VAD hygiene: the detector was reset between the turns
		expect(v.rec.resets).toBeGreaterThanOrEqual(1);
		voice.close();
	});
});
