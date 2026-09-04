// Real speech-to-text against the recommended local model (parakeet via
// transcribe.cpp). Generates speech with the macOS `say` CLI, so it only runs
// on darwin with a model available; it skips everywhere else.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Stt, resolveSttModel } from "../src/stt.ts";
import { decodeWav, toMono16k } from "../src/wav.ts";

const supported = process.platform === "darwin";
const modelStatus = resolveSttModel();

describe.skipIf(!supported || !modelStatus.ready)("stt (real model)", () => {
	const phrase = "omni agent bring the build back to green";
	let wavPath: string;

	it("transcribes say-generated speech", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sspi-stt-"));
		wavPath = join(dir, "input.wav");
		execFileSync("say", ["-o", wavPath, "--data-format=LEI16@16000", phrase]);

		const stt = Stt.create();
		const wav = decodeWav(readFileSync(wavPath));
		const text = await stt.transcribe(wav);
		await stt.dispose();
		rmSync(dir, { recursive: true, force: true });

		console.log(`transcript: "${text}"`);
		const normalized = text.toLowerCase().replace(/[^a-z ]/g, "");
		for (const word of ["omni", "agent", "green"]) {
			expect(normalized).toContain(word);
		}
	}, 120_000);

	it("streams partials for say-generated speech and finalizes the same phrase", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sspi-stt-stream-"));
		const wavPath = join(dir, "input.wav");
		execFileSync("say", ["-o", wavPath, "--data-format=LEI16@16000", phrase]);

		const stt = Stt.create();
		const pcm = toMono16k(decodeWav(readFileSync(wavPath)));
		const partials: Array<{ committed: string; tentative: string }> = [];
		let sawLiveText = false;

		const utt = await stt.openUtterance();
		if (!utt) throw new Error("expected the recommended model to support streaming");
		// feed in ~100 ms chunks like a real mic
		const chunk = 1600;
		for (let off = 0; off < pcm.length; off += chunk) {
			const slice = pcm.subarray(off, Math.min(off + chunk, pcm.length));
			const t = await utt.feed(slice);
			partials.push(t);
			if (t.committed.length > 0 || t.tentative.length > 0) sawLiveText = true;
		}
		const finalText = await utt.finalize();
		utt.dispose();
		await stt.dispose();
		rmSync(dir, { recursive: true, force: true });

		console.log(`stream partials: ${partials.length}, final: "${finalText.trim()}"`);
		const normalized = finalText.toLowerCase().replace(/[^a-z ]/g, "");
		for (const word of ["omni", "agent", "green"]) {
			expect(normalized).toContain(word);
		}
		// parakeet holds its hypothesis tentative until finalize — live text
		// (committed or tentative) must still flow for the caption UX
		expect(sawLiveText).toBe(true);
		expect(partials.length).toBeGreaterThan(3);
	}, 120_000);
});
