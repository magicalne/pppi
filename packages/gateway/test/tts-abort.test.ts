// Regression coverage for kokoro generate() scheduling: the engine can
// neither cancel an in-flight call nor overlap two of them, so the provider
// must (a) unblock the Speaker the moment an abort signal fires, (b) chain
// the orphaned generate behind the next synthesize, and (c) register every
// new generate on the serial chain synchronously — a bare `await serial`
// first would let two sessions pass the same resolved promise and overlap.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KokoroProvider, type TtsChunk } from "../src/tts.ts";

const kokoro = vi.hoisted(() => {
	// the FIRST generate of each test hangs until released (the
	// un-cancellable in-flight call); later calls resolve immediately —
	// keyed on call count, not pending resolvers. any overlapping call
	// throws: the engine supports no concurrency.
	const resolvers: Array<(v: { audio: Float32Array; rate: number }) => void> = [];
	let calls = 0;
	let inFlight = 0;
	const generate = vi.fn(() => {
		if (inFlight > 0) return Promise.reject(new Error("overlapping generate — engine supports no concurrency"));
		calls++;
		inFlight++;
		const done = (r: { audio: Float32Array; rate: number }) => {
			inFlight--;
			return r;
		};
		if (calls === 1) {
			return new Promise<{ audio: Float32Array; rate: number }>((r) => resolvers.push(r)).then(done);
		}
		return Promise.resolve({ audio: new Float32Array(4), rate: 24_000 }).then(done);
	});
	return {
		generate,
		releaseFirst: () => resolvers.shift()?.({ audio: new Float32Array(8), rate: 24_000 }),
		reset: () => {
			calls = 0;
			inFlight = 0;
			resolvers.length = 0;
			generate.mockClear();
		},
	};
});

vi.mock("kokoro-js", () => ({
	KokoroTTS: {
		from_pretrained: async () => ({ generate: kokoro.generate, sampling_rate: 24_000 }),
	},
}));

function fixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pppi-kokoro-abort-"));
	mkdirSync(join(dir, "onnx"), { recursive: true });
	writeFileSync(join(dir, "onnx", "model_quantized.onnx"), "x"); // all resolution needs
	return dir;
}

const firstChunk = (iter: AsyncIterable<TtsChunk>) =>
	(async () => {
		for await (const c of iter) return c;
		throw new Error("no chunk from the synthesis");
	})();

describe("KokoroProvider generate scheduling", () => {
	let dir: string;

	afterEach(() => {
		vi.unstubAllEnvs();
		kokoro.reset();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("non-streaming (PPPI_TTS_STREAM=0): races the abort signal so barge-in unblocks the Speaker, then serializes the next generate behind the orphan", async () => {
		vi.stubEnv("PPPI_TTS_STREAM", "0");
		dir = fixtureDir();
		const provider = new KokoroProvider([dir]);
		expect(provider.status.ready).toBe(true);

		// one long answer, generation pending…
		const ac = new AbortController();
		const iter = provider.synthesize("a long answer generated as one batch", ac.signal) as AsyncGenerator<
			TtsChunk,
			undefined,
			undefined
		>;
		const pending = iter.next();
		await vi.waitFor(() => expect(kokoro.generate).toHaveBeenCalledTimes(1));

		// …barge-in: pre-fix this await hangs until the engine finishes
		const started = Date.now();
		ac.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		expect(Date.now() - started).toBeLessThan(1_000);

		// the orphan completes out-of-band; the NEXT synthesize must wait for
		// it (no overlapping generate) and then speak normally
		kokoro.releaseFirst();
		const chunk = await Promise.race([
			firstChunk(provider.synthesize("next turn")),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("next generate never ran — orphan not chained")), 4_000),
			),
		]);
		expect(chunk.pcm.length).toBeGreaterThan(0);
		expect(kokoro.generate).toHaveBeenCalledTimes(2);
	});

	it("streaming (default): a second session queues behind a pending generate instead of overlapping it", async () => {
		vi.stubEnv("PPPI_TTS_STREAM", "1");
		dir = fixtureDir();
		const provider = new KokoroProvider([dir]);

		// session A's first segment hangs in generate…
		const a = firstChunk(provider.synthesize("First answer, sentence one. Sentence two. Sentence three."));
		await vi.waitFor(() => expect(kokoro.generate).toHaveBeenCalledTimes(1));

		// …session B starts while A is pending. pre-fix, B's `await serial`
		// saw the same resolved promise and entered generate() concurrently
		const b = firstChunk(provider.synthesize("Second answer, sentence one. Sentence two."));
		await new Promise((r) => setTimeout(r, 150));
		expect(kokoro.generate).toHaveBeenCalledTimes(1); // B queued behind A

		kokoro.releaseFirst();
		const [ca, cb] = await Promise.all([a, b]); // throws loudly on any overlap
		expect(ca.pcm.length).toBeGreaterThan(0);
		expect(cb.pcm.length).toBeGreaterThan(0);
	});

	it("an abort that lands while QUEUED skips the stale generate entirely — the next turn is not delayed behind it", async () => {
		vi.stubEnv("PPPI_TTS_STREAM", "0");
		dir = fixtureDir();
		const provider = new KokoroProvider([dir]);

		// A hangs in the (uncancellable) native call… (its chunks go unconsumed)
		void firstChunk(provider.synthesize("Hanging answer.", undefined));
		await vi.waitFor(() => expect(kokoro.generate).toHaveBeenCalledTimes(1));

		// B queues behind A, then its caller barge-ins while still QUEUED
		const acB = new AbortController();
		const b = firstChunk(provider.synthesize("Queued answer that will be aborted.", acB.signal));
		await new Promise((r) => setTimeout(r, 50));
		acB.abort();
		await expect(b).rejects.toThrow(/aborted/); // the race unblocks immediately

		// A finishes; B's queued callback must SKIP (signal set) — a fresh
		// turn then runs without waiting behind B's stale synthesis
		kokoro.releaseFirst();
		const c = await Promise.race([
			firstChunk(provider.synthesize("Fresh turn.")),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("fresh turn delayed behind a skipped-queue stale generate")), 4_000),
			),
		]);
		expect(c.pcm.length).toBeGreaterThan(0);
		// A ran, C ran — B never invoked the engine (pre-fix: B ran first, C waited)
		expect(kokoro.generate).toHaveBeenCalledTimes(2);
	});
});
