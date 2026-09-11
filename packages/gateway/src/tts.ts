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

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceTtsStatus } from "@pppi/protocol";
import type { VoiceTts } from "./voice.ts";
import { decodeWav } from "./wav.ts";

export type TtsChunk = { pcm: Buffer; rate: number };

export interface TtsProvider extends VoiceTts {
	readonly id: "kokoro" | "piper" | "macos-say";
	/** Eager-load any engine so the first reply speaks instantly. Resolves false on failure. */
	warm(): Promise<boolean>;
}

// ---------------------------------------------------------------- provider resolution

export function resolveTtsProvider(): TtsProvider {
	const explicit = (process.env.PPPI_TTS_PROVIDER ?? "auto").toLowerCase();
	if (explicit === "macos-say") return new MacosSayProvider();
	if (explicit === "piper") return new SherpaPiperProvider();
	const kokoro = new KokoroProvider();
	if (explicit === "kokoro") return kokoro;
	// auto: PPPI_TTS_MODEL pointing at a sherpa vits dir selects piper (the
	// same env var would otherwise confuse kokoro's resolver, and anyone who
	// downloaded a piper model clearly wants it)
	const piper = new SherpaPiperProvider();
	if (piper.status.ready) return piper;
	return kokoro.status.ready ? kokoro : new MacosSayProvider();
}

// ---------------------------------------------------------------- piper (sherpa-onnx)

/**
 * Fast path for live chat: a VITS/Piper model in sherpa-onnx's native runtime.
 * Piper trades some naturalness vs kokoro but decodes ~5x faster on CPU
 * (~170ms for a 10-word phrase, RTF ~0.05 on an M4) — with text-level
 * streaming that means near-instant first audio. Needs the sherpa-onnx-node
 * addon and a model dir:
 *   PPPI_TTS_PROVIDER=piper PPPI_TTS_MODEL=/path/to/vits-piper-en_US-amy-medium
 * (tarball: vits-piper-en_US-amy-medium.tar.bz2 from k2-fsa/sherpa-onnx
 *  releases, tts-models tag — contains the .onnx, tokens.txt, espeak-ng-data)
 */
export function resolvePiperModel(): { dir: string; onnx: string } | { reason: string } {
	const explicit = process.env.PPPI_TTS_MODEL;
	if (!explicit) {
		return { reason: "piper needs PPPI_TTS_MODEL pointing at a sherpa-onnx vits model dir (see tts.ts)" };
	}
	if (!existsSync(explicit)) return { reason: `PPPI_TTS_MODEL dir missing: ${explicit}` };
	const onnx = readdirSync(explicit).find((f) => f.endsWith(".onnx"));
	if (!onnx) return { reason: `PPPI_TTS_MODEL dir has no .onnx: ${explicit}` };
	for (const need of ["tokens.txt", "espeak-ng-data"]) {
		if (!existsSync(join(explicit, need))) return { reason: `piper model dir lacks ${need}: ${explicit}` };
	}
	return { dir: explicit, onnx: join(explicit, onnx) };
}

export class SherpaPiperProvider implements TtsProvider {
	readonly id = "piper" as const;
	private loading: Promise<PiperEngine | null> | null = null;
	readonly status: VoiceTtsStatus;

	constructor() {
		const model = resolvePiperModel();
		this.status =
			"reason" in model
				? ({ ready: false, reason: model.reason } as VoiceTtsStatus)
				: ({ ready: true, provider: this.id, voice: model.onnx.split("/").pop() ?? "piper" } as VoiceTtsStatus);
	}

	synthesize(text: string): AsyncIterable<TtsChunk> {
		const provider = this;
		return (async function* () {
			if (!provider.status.ready) throw new Error(provider.status.reason);
			provider.loading ??= loadPiperEngine();
			const engine = await provider.loading;
			if (!engine) throw new Error("sherpa-onnx piper engine failed to load");
			// same text-level streaming as kokoro: short first phrase, larger rest
			for (const seg of streamSegments(text)) {
				const { samples, rate } = await engine.generate(seg);
				yield* floatPcmChunks(samples, rate);
			}
		})();
	}

	async warm(): Promise<boolean> {
		if (!this.status.ready) return false;
		this.loading ??= loadPiperEngine();
		return (await this.loading) !== null;
	}
}

type PiperEngine = { generate(text: string): Promise<{ samples: Float32Array; rate: number }> };

async function loadPiperEngine(): Promise<PiperEngine | null> {
	const model = resolvePiperModel();
	if ("reason" in model) return null;
	let addon: { OfflineTts: new (cfg: Record<string, unknown>) => any };
	try {
		// optional native dependency — absent addon means "provider unavailable".
		// CJS module: createRequire, because a bare dynamic import of it loses
		// the constructor through ESM interop.
		const { createRequire } = await import("node:module");
		addon = createRequire(import.meta.url)("sherpa-onnx-node");
	} catch {
		return null;
	}
	const tts = new addon.OfflineTts({
		model: { vits: { model: model.onnx, tokens: join(model.dir, "tokens.txt"), dataDir: join(model.dir, "espeak-ng-data") } },
		numThreads: 2,
		debug: false,
		provider: "cpu",
	});
	return {
		generate: async (text) => {
			const audio = await tts.generateAsync({ text, sid: 0, speed: 1.0 });
			return { samples: audio.samples as Float32Array, rate: audio.sampleRate as number };
		},
	};
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
			// kokoro-js has no native streaming, so stream at the TEXT level:
			// generate a short first phrase for fast first-audio, then larger
			// phrases that stay hidden behind the audio already playing. Whole-
			// sentence generation (old behavior) with PPPI_TTS_STREAM=0.
			if (provider.streaming) {
				for (const seg of streamSegments(text)) {
					const { audio, rate } = await engine.generate(seg, DEFAULT_KOKORO_VOICE);
					yield* floatPcmChunks(audio, rate);
				}
				return;
			}
			const { audio, rate } = await engine.generate(text, DEFAULT_KOKORO_VOICE);
			yield* floatPcmChunks(audio, rate);
		})();
	}

	/** phrase-chunked synthesis (see synthesize); default on */
	private readonly streaming = (process.env.PPPI_TTS_STREAM ?? "1") !== "0";

	async warm(): Promise<boolean> {
		if (!this.status.ready) return false;
		this.loading ??= loadKokoroEngine();
		return (await this.loading) !== null;
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

/**
 * Split prose into phrase-sized generation units for text-level streaming.
 * The first unit is kept short — it alone gates time-to-first-audio — while
 * later units are larger because playback of earlier audio hides their
 * generation. Breaks prefer natural boundaries (sentence end, then comma)
 * and only fall back to a word boundary when a clause is far too long.
 */
export function streamSegments(text: string, firstWords = 6, restWords = 20): string[] {
	const clauses: string[] = [];
	for (const sentence of text.split(/(?<=[.!?])\s+/)) {
		const trimmed = sentence.trim();
		if (!trimmed) continue;
		// split overly long sentences at commas so no unit blows the budget
		let current = "";
		for (const part of trimmed.split(/(?<=[,;:])\s+/)) {
			const candidate = current ? `${current} ${part}` : part;
			if (wordCount(candidate) > Math.max(restWords, wordCount(part)) && current) {
				clauses.push(current);
				current = part;
			} else {
				current = candidate;
			}
		}
		if (current) clauses.push(current);
	}
	const segments: string[] = [];
	for (const clause of clauses) {
		const budget = segments.length === 0 ? firstWords : restWords;
		if (wordCount(clause) <= budget) {
			segments.push(clause);
			continue;
		}
		const words = clause.split(/\s+/);
		for (let off = 0; off < words.length; off += budget) {
			segments.push(words.slice(off, off + budget).join(" "));
		}
	}
	return segments.filter((s) => s.trim().length > 0);
}

function wordCount(s: string): number {
	return s.trim() ? s.trim().split(/\s+/).length : 0;
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

	async warm(): Promise<boolean> {
		return this.status.ready;
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
			if (list.split("\n").some((l: string) => l.includes(want))) return want;
		}
	} catch {
		// non-darwin or say missing — say will error at synth time
	}
	return "Samantha";
}
