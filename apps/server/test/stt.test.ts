// Real speech-to-text against the recommended local model (parakeet via
// transcribe.cpp). Generates speech with the macOS `say` CLI, so it only runs
// on darwin with a model available; it skips everywhere else.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSttModel, Stt } from "../src/stt.ts";
import { decodeWav } from "../src/wav.ts";

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
});
