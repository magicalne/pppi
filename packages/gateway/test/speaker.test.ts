// Unit tests for the Speaker (sentence chunking, abort semantics, stale-turn
// dropping) and speakProse — the speaking half of interactive voice, driven
// with fake TTS providers so the turn-taking races are deterministic.

import type { VoiceServerEvent } from "@pppi/protocol";
import { describe, expect, it } from "vitest";
import { Speaker, type VoiceTts, abortError, speakProse } from "../src/voice.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, ms = 5_000): Promise<void> {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await sleep(10);
	}
}

/** Records every event/binary frame the Speaker emits. */
function recorder() {
	const events: VoiceServerEvent[] = [];
	const binary: Buffer[] = [];
	return {
		events,
		binary,
		sendEvent: (e: VoiceServerEvent) => void events.push(e),
		sendBinary: (b: Buffer) => void binary.push(b),
		starts: () => events.filter((e) => e.type === "tts_start") as Array<{ id: string; rate: number }>,
		ends: () => events.filter((e) => e.type === "tts_end") as Array<{ id: string; interrupted?: boolean }>,
		errors: () => events.filter((e) => e.type === "voice_error") as Array<{ message: string }>,
	};
}

/**
 * A TTS whose first chunk is delayed: syntheses are identifiable by index —
 * every PCM chunk the item emits carries its index — and an abort signal ends
 * the generator with AbortError (the provider-side seam Speaker relies on).
 */
function delayedTts(delayMs: number) {
	const received: string[] = [];
	const provider: VoiceTts = {
		status: { ready: true, provider: "fake", voice: "v" },
		synthesize(text: string, signal?: AbortSignal) {
			const idx = received.length;
			received.push(text);
			return (async function* () {
				await sleep(delayMs);
				if (signal?.aborted) throw abortError("aborted before first audio");
				for (let i = 0; i < 3; i++) {
					yield { pcm: Buffer.from([idx]), rate: 16_000 };
					await sleep(15);
					if (signal?.aborted) throw abortError("aborted mid-audio");
				}
			})();
		},
	};
	return { provider, received };
}

describe("Speaker abort seam", () => {
	it("abort() cancels an in-flight synthesis through the signal and marks it interrupted", async () => {
		// the provider only ever stops when ITS signal fires — without the
		// Speaker passing one (the old behavior), this generator never ends
		// and the interrupted tts_end never arrives (test times out)
		const received: string[] = [];
		const provider: VoiceTts = {
			status: { ready: true, provider: "fake", voice: "v" },
			synthesize(text: string, signal?: AbortSignal) {
				const idx = received.length;
				received.push(text);
				return (async function* () {
					yield { pcm: Buffer.from([idx]), rate: 16_000 }; // tts_start fires
					if (idx === 0) {
						while (!signal?.aborted) await sleep(10);
						throw abortError("synthesis aborted");
					}
					for (let i = 0; i < 2; i++) yield { pcm: Buffer.from([idx]), rate: 16_000 };
				})();
			},
		};
		const rec = recorder();
		const speaker = new Speaker(provider, rec.sendBinary, rec.sendEvent);

		speaker.beginTurn();
		speaker.assistantDelta("t1", "A sentence that will be cut off.");
		await until(() => rec.starts().length === 1);
		speaker.abort();

		await until(() => rec.ends().length === 1);
		expect(rec.ends()[0]).toMatchObject({ interrupted: true });
		expect(rec.errors()).toEqual([]); // an abort is a clean stop, not a failure

		// the next turn speaks immediately — nothing is left blocking the queue
		speaker.speakWhole("Next turn text.");
		await until(() => rec.ends().length === 2);
		expect(received).toEqual(["A sentence that will be cut off.", "Next turn text."]);
		expect(rec.ends()[1]).not.toHaveProperty("interrupted", true);
	});

	it("drops stale audio silently when the turn is aborted before first audio and a new turn begins", async () => {
		// the race: abort() lands before the first chunk (no interrupted
		// marker was sent), beginTurn() resets the mutable flag, and the old
		// drain then emitted CLEAN tts_start+audio+tts_end for text the user
		// cut off. Items dequeued under an older epoch must drop silently.
		const { provider, received } = delayedTts(80);
		const rec = recorder();
		const speaker = new Speaker(provider, rec.sendBinary, rec.sendEvent);

		speaker.beginTurn();
		speaker.assistantDelta("t1", "Stale sentence one. Stale sentence two."); // ≥1 item, first chunk at ~80ms
		await sleep(20); // still pre-first-audio
		speaker.abort(); // user cuts it off — nothing started, no marker
		speaker.beginTurn(); // the next turn goes out immediately
		speaker.assistantDelta("t2", "Fresh sentence.");

		await until(() => rec.ends().length === 1, 5_000);
		await sleep(120); // give a stale drain every chance to misbehave
		expect(rec.starts()).toHaveLength(1); // exactly one stream opened — the fresh one
		// and every audio frame belongs to it: stale chunks are index 0, fresh 1+
		expect(rec.binary.map((b) => b[0])).not.toContain(0);
		expect(rec.ends()[0]).not.toHaveProperty("interrupted", true);
		expect(received.at(-1)).toBe("Fresh sentence.");
	});

	it("one failed synthesis reports itself without nuking the rest of the queue", async () => {
		let call = 0;
		const received: string[] = [];
		const provider: VoiceTts = {
			status: { ready: true, provider: "fake", voice: "v" },
			synthesize(text: string) {
				received.push(text);
				const idx = call++;
				return (async function* () {
					if (idx === 0) throw new Error("engine exploded");
					yield { pcm: Buffer.from([idx]), rate: 16_000 };
				})();
			},
		};
		const rec = recorder();
		const speaker = new Speaker(provider, rec.sendBinary, rec.sendEvent);

		speaker.beginTurn();
		speaker.assistantDelta("t1", "First dies. Second survives.");

		await until(() => rec.starts().length === 1, 5_000);
		expect(received).toEqual(["First dies.", "Second survives."]); // the queue was not cleared
		expect(rec.errors()).toHaveLength(1); // the failure was reported…
		expect(rec.errors()[0]?.message).toContain("engine exploded");
		expect(rec.ends()).toHaveLength(1); // …and the surviving item completed cleanly
	});
});

describe("Speaker sentence chunking", () => {
	it("speaks the final tail after two or more sentences already arrived via deltas", async () => {
		// takeSentences returns trimmed sentences; the old code concatenated
		// them into `emitted` WITHOUT the whitespace between, so the final's
		// prefix guard failed and the tail was silently dropped
		const { provider, received } = delayedTts(0);
		const rec = recorder();
		const speaker = new Speaker(provider, rec.sendBinary, rec.sendEvent);

		speaker.beginTurn();
		speaker.assistantDelta("m1", "One. Two. ");
		await until(() => received.length === 2);
		speaker.assistantFinal("m1", "One. Two. Three.");

		await until(() => received.length === 3, 5_000);
		expect(received).toEqual(["One.", "Two.", "Three."]);
	});

	it("stays quiet when the final text was rewritten mid-flight", async () => {
		const { provider, received } = delayedTts(0);
		const rec = recorder();
		const speaker = new Speaker(provider, rec.sendBinary, rec.sendEvent);

		speaker.beginTurn();
		speaker.assistantDelta("m1", "One. ");
		await until(() => received.length === 1);
		speaker.assistantFinal("m1", "Something entirely different."); // does NOT start with the emitted prefix
		await sleep(80);
		expect(received).toEqual(["One."]); // nothing further spoken
	});

	it("speakWhole speaks a delta-less text under the caller's id (delegated peer reply)", async () => {
		const { provider, received } = delayedTts(0);
		const rec = recorder();
		const speaker = new Speaker(provider, rec.sendBinary, rec.sendEvent);

		speaker.speakWhole("A delegated answer.", "peer-reply-1");
		await until(() => rec.ends().length === 1, 5_000);
		expect(received).toEqual(["A delegated answer."]);
		expect(rec.starts()[0]?.id).toBe("peer-reply-1"); // the wire id survives
		expect(rec.ends()[0]).toMatchObject({ id: "peer-reply-1" });
	});

	it("a new turn drops the previous turn's still-queued sentences", async () => {
		const { provider, received } = delayedTts(30);
		const rec = recorder();
		const speaker = new Speaker(provider, rec.sendBinary, rec.sendEvent);
		const listenings = () =>
			rec.events.filter((e) => e.type === "voice_state" && (e as any).state === "listening").length;

		speaker.beginTurn();
		speaker.assistantDelta("a", "One. Two. Three."); // three sentences queued
		await until(() => rec.starts().length === 1); // "One." is speaking
		speaker.beginTurn(); // user cuts in — "Two."/"Three." are stale queue
		speaker.assistantDelta("b", "Fresh.");
		await until(() => rec.starts().length === 2 && listenings() >= 2);

		// pre-fix: drain dequeued "Two." under the NEW epoch and spoke it
		expect(received).toEqual(["One.", "Fresh."]);
	});

	it("a synthesis failure on the last item hands the mic back (listening)", async () => {
		let calls = 0;
		const received: string[] = [];
		const provider: VoiceTts = {
			status: { ready: true, provider: "fake", voice: "v" },
			synthesize(text: string) {
				const idx = calls++;
				received.push(text);
				return (async function* () {
					if (idx === 1) throw new Error("boom"); // last item fails before any audio
					for (let i = 0; i < 2; i++) yield { pcm: Buffer.from([idx]), rate: 16_000 };
				})();
			},
		};
		const rec = recorder();
		const speaker = new Speaker(provider, rec.sendBinary, rec.sendEvent);

		speaker.beginTurn();
		speaker.assistantDelta("t", "First one. Second one."); // two sentences
		await until(() => rec.errors().length === 1);

		const states = rec.events.filter((e) => e.type === "voice_state");
		// the first item ended with its successor still queued (no listening);
		// without the failure-path emit the client stays stranded in speaking
		expect(states.at(-1)).toMatchObject({ state: "listening" });
		expect(received).toEqual(["First one.", "Second one."]);
	});
});

describe("speakProse", () => {
	it("strips a trailing unclosed code fence", () => {
		expect(speakProse("Look. ```js\nlet x = 1")).toBe("Look. Code is on the screen.");
		expect(speakProse("```\nunclosed block")).toBe("Code is on the screen.");
		expect(speakProse("``")).toBe("``"); // not a fence
	});

	it("does not eat the closing paren of a parenthesised bare URL", () => {
		expect(speakProse("see (https://example.com/a) now")).toBe("see ( a link ) now");
		// parenthesised URL characters still belong to the URL when opened inside it
		expect(speakProse("wiki https://en.wikipedia.org/wiki/Foo_(bar) here")).toBe("wiki a link here");
	});
});
