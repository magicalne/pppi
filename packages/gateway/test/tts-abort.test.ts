// Regression coverage for the PPPI_TTS_STREAM=0 abort path: a full-answer
// kokoro generate() the engine can neither cancel nor overlap must still
// (a) unblock the Speaker the moment the abort signal fires, and (b) chain
// the orphaned generate behind the next synthesize call.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KokoroProvider, type TtsChunk } from "../src/tts.ts";

const kokoro = vi.hoisted(() => {
	// first generate hangs until released (the un-cancellable in-flight call);
	// every later call resolves immediately — keyed on call COUNT, not pending
	// resolvers (releasing the first would otherwise make call two hang too)
	const resolvers: Array<(v: { audio: Float32Array; rate: number }) => void> = [];
	let calls = 0;
	const generate = vi.fn(() => {
		calls++;
		if (calls === 1) return new Promise<{ audio: Float32Array; rate: number }>((r) => resolvers.push(r));
		return Promise.resolve({ audio: new Float32Array(4), rate: 24_000 });
	});
	return {
		generate,
		releaseFirst: () => resolvers.shift()?.({ audio: new Float32Array(8), rate: 24_000 }),
	};
});

vi.mock("kokoro-js", () => ({
	KokoroTTS: {
		from_pretrained: async () => ({ generate: kokoro.generate, sampling_rate: 24_000 }),
	},
}));

describe("KokoroProvider non-streaming abort (PPPI_TTS_STREAM=0)", () => {
	let dir: string;

	afterEach(() => {
		vi.unstubAllEnvs();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("races the abort signal so barge-in unblocks the Speaker, then serializes the next generate behind the orphan", async () => {
		vi.stubEnv("PPPI_TTS_STREAM", "0");
		dir = mkdtempSync(join(tmpdir(), "pppi-kokoro-abort-"));
		mkdirSync(join(dir, "onnx"), { recursive: true });
		writeFileSync(join(dir, "onnx", "model_quantized.onnx"), "x"); // all resolution needs

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
			(async () => {
				for await (const c of provider.synthesize("next turn")) return c;
				throw new Error("no chunk from the second synthesis");
			})(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("next generate never ran — orphan not chained")), 4_000),
			),
		]);
		expect(chunk.pcm.length).toBeGreaterThan(0);
		expect(kokoro.generate).toHaveBeenCalledTimes(2);
	});
});
