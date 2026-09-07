// Local text-to-speech for interactive mode. Same posture as stt.ts: models
// live on this Mac, nothing leaves the machine. Providers are pluggable —
// pick with PPPI_TTS_PROVIDER=kokoro|macos-say|auto (default auto: kokoro
// when its model is cached, else the always-available macOS `say`).
//
// Kokoro model resolution order (mirrors stt.ts):
//   1. $PPPI_TTS_MODEL (dir containing a kokoro .onnx + voices.bin, or the .onnx itself)
//   2. onnx-community/Kokoro-82M-v1.0-ONNX in the HuggingFace cache
//
// synthesize() takes PROSE ONLY — strip code/markdown with speakProse()
// before calling; a coding agent's raw answer is garbage out loud.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceTtsStatus } from "@pppi/protocol";
import { decodeWav } from "./wav.ts";

export type TtsChunk = { pcm: Buffer; rate: number };

export interface TtsProvider extends VoiceTts {
	readonly id: "kokoro" | "macos-say";
}

// ---------------------------------------------------------------- provider resolution

export function resolveTtsProvider(): TtsProvider {
	const explicit = (process.env.PPPI_TTS_PROVIDER ?? "auto").toLowerCase();
	if (explicit === "macos-say") return new MacosSayProvider();
	const kokoro = new KokoroProvider();
	if (explicit === "kokoro") return kokoro;
	return kokoro.status.ready ? kokoro : new MacosSayProvider();
}

// ---------------------------------------------------------------- kokoro

const KOKORO_REPO_DIR = "models--onnx-community--Kokoro-82M-v1.0-ONNX";
const DEFAULT_KOKORO_VOICE = "af_heart";

export function resolveKokoroModel(): { dir: string } | { reason: string } {
	const explicit = process.env.PPPI_TTS_MODEL;
	if (explicit) {
		const onnxPath = existsSync(explicit) ? findOnnx(explicit) : "";
		if (onnxPath) return { dir: explicit };
		if (explicit) return { reason: `PPPI_TTS_MODEL dir has no onnx/model*.onnx: ${explicit}` };
	}
	// HF cache snapshots (as laid out by `huggingface-cli download` or git lfs)
	const hfCache = join(homedir(), ".cache", "huggingface", "hub", KOKORO_REPO_DIR, "snapshots");
	try {
		for (const snap of readdirSync(hfCache)) {
			const dir = join(hfCache, snap);
			if (findOnnx(dir)) return { dir };
		}
	} catch {
		// not cached
	}
	return {
		reason: `no kokoro model cached — download ${KOKORO_REPO_DIR} (config.json, onnx/model_quantized.onnx, voices/<voice>.bin) and set PPPI_TTS_MODEL, or run: bunx --bun huggingface-cli download onnx-community/Kokoro-82M-v1.0-ONNX --include "onnx/model_quantized.onnx" "voices/af_heart.bin" "config.json" "tokenizer*"`,
	};
}

/** Any onnx/model*.onnx under `dir/onnx/` (the HF repo layout). */
function findOnnx(dir: string): string {
	const onnxDir = join(dir, "onnx");
	try {
		const files = readdirSync(onnxDir);
		for (const want of ["model_quantized.onnx", "model.onnx"]) {
			if (files.includes(want)) return join(onnxDir, want);
		}
	} catch {
		// missing dir
	}
	return "";
}

export class KokoroProvider implements TtsProvider {
	readonly id = "kokoro" as const;
	private loading: Promise<KokoroEngine | null> | null = null;
	readonly status: VoiceTtsStatus;

	constructor() {
		this.status = (() => {
			const model = resolveKokoroModel();
			return "reason" in model
				? ({ ready: false, reason: model.reason } as VoiceTtsStatus)
				: ({ ready: true, provider: this.id, voice: DEFAULT_KOKORO_VOICE } as VoiceTtsStatus);
		})();
	}

	synthesize(text: string): AsyncIterable<TtsChunk> {
		const provider = this;
		return (async function* () {
			if (!provider.status.ready) throw new Error(provider.status.reason);
			provider.loading ??= loadKokoroEngine();
			const engine = await provider.loading;
			if (!engine) throw new Error("kokoro engine failed to load");
			const { audio, rate } = await engine.generate(text, DEFAULT_KOKORO_VOICE);
			yield* floatPcmChunks(audio, rate);
		})();
	}
}

type KokoroEngine = {
	generate(text: string, voice: string): Promise<{ audio: Float32Array; rate: number }>;
};

async function loadKokoroEngine(): Promise<KokoroEngine | null> {
	const model = resolveKokoroModel();
	if ("reason" in model) return null;
	// kokoro-js wraps transformers.js + onnxruntime; loaded lazily so the
	// gateway boots fine (macos-say fallback) without the dependency used.
	const mod = (await import("kokoro-js")) as unknown as {
		KokoroTTS: {
			from_pretrained(
				repo: string,
				opts?: Record<string, unknown>,
			): Promise<{
				generate(text: string, opts?: Record<string, unknown>): Promise<{ audio: Float32Array }>;
				sampling_rate?: number;
			}>;
		};
	};
	// local snapshot dir (PPPI_TTS_MODEL or the HF cache) — never the network
	const tts = await mod.KokoroTTS.from_pretrained(model.dir, {
		dtype: "q8",
		device: "cpu",
	});
	const rate = tts.sampling_rate ?? 24000;
	return {
		generate: async (text, voice) => {
			const out = await tts.generate(text, { voice });
			return { audio: out.audio, rate };
		},
	};
}

/** Float32 (-1..1) → s16le Buffer chunks of ~50 ms. */
export function floatPcmChunks(samples: Float32Array, rate: number, chunkMs = 50): AsyncIterable<TtsChunk> {
	const perChunk = Math.max(1, Math.floor((rate * chunkMs) / 1000));
	return (async function* () {
		for (let off = 0; off < samples.length; off += perChunk) {
			const n = Math.min(perChunk, samples.length - off);
			const buf = Buffer.alloc(n * 2);
			for (let i = 0; i < n; i++) {
				const v = Math.max(-1, Math.min(1, samples[off + i] ?? 0));
				buf.writeInt16LE(Math.round(v * 32767), i * 2);
			}
			yield { pcm: buf, rate };
		}
	})();
}

// ---------------------------------------------------------------- macos say

/** The always-works fallback: macOS `say` → WAV → PCM chunks. */
export class MacosSayProvider implements TtsProvider {
	readonly id = "macos-say" as const;
	readonly status: VoiceTtsStatus;
	private voice: string;

	constructor(voice?: string) {
		this.voice = voice ?? process.env.PPPI_SAY_VOICE ?? pickSayVoice();
		this.status = {
			ready: true,
			provider: this.id,
			voice: this.voice,
		};
	}

	async *synthesize(text: string): AsyncIterable<TtsChunk> {
		const dir = mkdtempSync(join(tmpdir(), "pppi-say-"));
		const wavPath = join(dir, "out.wav");
		try {
			await new Promise<void>((resolve, reject) => {
				const proc = spawn("say", ["-v", this.voice, "--data-format=LEI16@22050", "-o", wavPath, text]);
				proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`say exited ${code}`))));
				proc.on("error", reject);
			});
			const wav = decodeWav(readFileSync(wavPath));
			// wav.samples is interleaved float; `say` gives mono 16-bit at 22.05 kHz
			yield* floatPcmChunks(wav.samples, wav.sampleRate);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

function pickSayVoice(): string {
	// premium voices sound best; fall back through what's installed
	const preferred = ["Ava (Premium)", "Zoe (Premium)", "Ava", "Samantha"];
	try {
		const list = execFileSync("say", ["-v", "?"], { encoding: "utf8" });
		for (const want of preferred) {
			if (list.split("\n").some((l) => l.includes(want))) return want;
		}
	} catch {
		// non-darwin or say missing — say will error at synth time
	}
	return "Samantha";
}
