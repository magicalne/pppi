// Speech fixtures for real-model tests: synthesize a spoken phrase as WAV
// bytes, cross-platform. macOS `say` was the original generator; the Linux
// ports use the same ladder the gateway's TTS uses —
//   piper   the sherpa-onnx vits model (neural, most STT-friendly)
//   say     macOS (neural-ish system voices)
//   espeak-ng  everywhere after `apt install espeak-ng` (robotic; fine for
//              VAD/turn-taking tests, weaker for transcription quality)
// Tests that assert transcript QUALITY gate on piper/say; tests that only
// need voice-shaped audio (barge-in, endpointing) accept espeak-ng too.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable, resolvePiperModel } from "../src/tts.ts";
import { decodeWav, encodeWav16k, toMono16k } from "../src/wav.ts";

export type SpeechGenerator = "piper" | "say" | "espeak-ng";

let piperEngine: { generate(text: string): Promise<{ samples: Float32Array; rate: number }> } | null | undefined;

/** Best available generator, or null when nothing can synthesize (sync — safe in describe.skipIf). */
export function speechGenerator(): SpeechGenerator | null {
	if (loadPiper() !== null) return "piper";
	if (process.platform === "darwin") return "say";
	if (findEspeak()) return "espeak-ng";
	return null;
}

/** True when the generator is good enough to assert transcript contents. */
export function transcriptQualityGenerator(gen: SpeechGenerator | null): boolean {
	return gen === "piper" || gen === "say";
}

/** Synthesize `phrase` → WAV file bytes (mono PCM16, native rate of the generator). Cached per phrase. */
export async function speak(phrase: string): Promise<Buffer> {
	const cache = spokenCache.get(phrase);
	if (cache) return cache;
	const piper = loadPiper();
	let wav: Buffer;
	if (piper) {
		const { samples, rate } = await piper.generate(phrase);
		wav = encodeWav16k(samples, rate);
	} else if (process.platform === "darwin") {
		const dir = mkdtempSync(join(tmpdir(), "pppi-speech-"));
		try {
			const path = join(dir, "s.wav");
			execFileSync("say", ["-o", path, "--data-format=LEI16@16000", phrase]);
			wav = readFileSync(path);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	} else {
		const bin = findEspeak();
		if (!bin) throw new Error("no speech generator: piper model, macOS say, or espeak-ng required");
		wav = execFileSync(bin, ["-v", "en-us", "-s", "150", "--stdout", phrase]);
	}
	spokenCache.set(phrase, wav);
	return wav;
}

const spokenCache = new Map<string, Buffer>();

/** speak() as raw 16 kHz mono PCM16 — exactly what a /voice mic stream carries. */
export async function speakPcm16k(phrase: string): Promise<Buffer> {
	const mono = toMono16k(decodeWav(await speak(phrase)));
	const pcm = Buffer.alloc(mono.length * 2);
	for (let i = 0; i < mono.length; i++) {
		const v = Math.max(-1, Math.min(1, mono[i] ?? 0));
		pcm.writeInt16LE(Math.round(v * 32767), i * 2);
	}
	return pcm;
}

/** Lazily build the in-process piper engine; null when model/addon missing. */
function loadPiper(): { generate(text: string): Promise<{ samples: Float32Array; rate: number }> } | null {
	if (piperEngine !== undefined) return piperEngine;
	piperEngine = null;
	try {
		const model = resolvePiperModel();
		if ("reason" in model) return null;
		const addon = createRequire(import.meta.url)("sherpa-onnx-node") as {
			OfflineTts: new (cfg: Record<string, unknown>) => any;
		};
		const tts = new addon.OfflineTts({
			model: {
				vits: { model: model.onnx, tokens: join(model.dir, "tokens.txt"), dataDir: join(model.dir, "espeak-ng-data") },
			},
			numThreads: 2,
			debug: false,
			provider: "cpu",
		});
		piperEngine = {
			generate: async (text) => {
				const audio = await tts.generateAsync({ text, sid: 0, speed: 1.0 });
				return { samples: audio.samples as Float32Array, rate: audio.sampleRate as number };
			},
		};
	} catch {
		piperEngine = null;
	}
	return piperEngine;
}

function findEspeak(): string | null {
	return findExecutable("espeak-ng");
}
