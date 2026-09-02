// Local speech-to-text for the voice channel, using the same stack as
// earendil-works/pi-transcribe: transcribe.cpp GGUF models, recommended model
// parakeet-unified-en-0.6b (rank 1 in pi-transcribe's catalog).
//
// Model resolution order:
//   1. $SSPI_STT_MODEL (explicit gguf path)
//   2. pi-transcribe's configured model (~/.pi/agent/pi-transcribe.json)
//   3. pi-transcribe's recommended model in the HuggingFace cache

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { toMono16k, type DecodedWav } from "./wav.ts";

const RECOMMENDED_REPO_DIR = "models--handy-computer--parakeet-unified-en-0.6b-gguf";
const RECOMMENDED_FILE = "parakeet-unified-en-0.6b-Q8_0.gguf";

export type SttStatus = { ready: true; modelPath: string; modelId: string } | { ready: false; reason: string };

export function resolveSttModel(): SttStatus {
	const explicit = process.env.SSPI_STT_MODEL;
	if (explicit) {
		if (!existsSync(explicit)) return { ready: false, reason: `SSPI_STT_MODEL points to a missing file: ${explicit}` };
		return { ready: true, modelPath: explicit, modelId: explicit };
	}

	const piTranscribeCfg = join(homedir(), ".pi", "agent", "pi-transcribe.json");
	try {
		const cfg = JSON.parse(readFileSync(piTranscribeCfg, "utf8")) as { model?: { path?: string; id?: string } };
		if (cfg.model?.path && existsSync(cfg.model.path)) {
			return { ready: true, modelPath: cfg.model.path, modelId: cfg.model.id ?? "pi-transcribe model" };
		}
	} catch {
		// fall through
	}

	const hfCache = join(homedir(), ".cache", "huggingface", "hub", RECOMMENDED_REPO_DIR, "snapshots");
	try {
		for (const snap of readdirSync(hfCache)) {
			const candidate = join(hfCache, snap, RECOMMENDED_FILE);
			if (existsSync(candidate)) return { ready: true, modelPath: candidate, modelId: RECOMMENDED_FILE };
		}
	} catch {
		// fall through
	}

	return {
		ready: false,
		reason:
			`no local STT model found. Run /transcribe once in pi (pi-transcribe) to download the ` +
			`recommended model (${RECOMMENDED_FILE}), or set SSPI_STT_MODEL=/path/to/model.gguf`,
	};
}

export class Stt {
	private model:
		| { transcribe(pcm: Float32Array, opts?: Record<string, unknown>): Promise<{ text: string }>; dispose?(): void }
		| null = null;
	private loading: Promise<void> | null = null;
	readonly status: SttStatus;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(status: SttStatus) {
		this.status = status;
	}

	static create(opts: { disabled?: boolean } = {}): Stt {
		return new Stt(opts.disabled ? { ready: false, reason: "STT disabled (--no-stt)" } : resolveSttModel());
	}

	get ready(): boolean {
		return this.status.ready;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.model) return;
		this.loading ??= (async () => {
			if (!this.status.ready) throw new Error(this.status.reason);
			const mod = (await import("transcribe-cpp")) as {
				TranscribeModel: { load(path: string): Promise<unknown> };
			};
			this.model = (await mod.TranscribeModel.load(this.status.modelPath)) as Stt["model"];
		})();
		await this.loading;
	}

	/** Transcribe a decoded WAV; serialized so one model serves concurrent requests. */
	async transcribe(wav: DecodedWav): Promise<string> {
		await this.ensureLoaded();
		const pcm = toMono16k(wav);
		if (pcm.length < 1600) return ""; // <0.1s of audio
		const run = this.queue.then(async () => {
			const result = await this.model!.transcribe(pcm);
			return result.text.trim();
		});
		this.queue = run.catch(() => undefined);
		return run;
	}

	async dispose(): Promise<void> {
		this.model?.dispose?.();
		this.model = null;
		this.loading = null;
	}
}
