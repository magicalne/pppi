// Real speech-to-text against the recommended local model (parakeet via
// transcribe.cpp). Speech is synthesized with whatever generator the machine
// has (piper > macOS `say`; see test/speech.ts) — quality assertions need a
// neural voice, so espeak-ng-only machines skip. Runs on macOS and Linux.

import { describe, expect, it } from "vitest";
import { Stt, resolveSttModel } from "../src/stt.ts";
import { decodeWav, toMono16k } from "../src/wav.ts";
import { speak, speechGenerator, transcriptQualityGenerator } from "./speech.ts";

const modelStatus = resolveSttModel();
const gen = speechGenerator();
const supported = modelStatus.ready && transcriptQualityGenerator(gen);

describe.skipIf(!supported)("stt (real model)", () => {
	const phrase = "omni agent bring the build back to green";

	it(`transcribes ${gen}-generated speech`, async () => {
		const stt = Stt.create();
		const wav = decodeWav(await speak(phrase));
		const text = await stt.transcribe(wav);
		await stt.dispose();

		console.log(`transcript: "${text}"`);
		const normalized = text.toLowerCase().replace(/[^a-z ]/g, "");
		for (const word of ["omni", "agent", "green"]) {
			expect(normalized).toContain(word);
		}
	}, 120_000);

	it(`streams partials for ${gen}-generated speech and finalizes the same phrase`, async () => {
		const stt = Stt.create();
		const pcm = toMono16k(decodeWav(await speak(phrase)));
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
