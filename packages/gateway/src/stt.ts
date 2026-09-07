// Local speech-to-text for the voice channel, using the same stack as
// earendil-works/pi-transcribe: transcribe.cpp GGUF models, recommended model
// parakeet-unified-en-0.6b (rank 1 in pi-transcribe's catalog).
//
// Model resolution order:
//   1. $PPPI_STT_MODEL (explicit gguf path)
//   2. pi-transcribe's configured model (~/.pi/agent/pi-transcribe.json)
//   3. pi-transcribe's recommended model in the HuggingFace cache

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DecodedWav, toMono16k } from "./wav.ts";

const RECOMMENDED_REPO_DIR = "models--handy-computer--parakeet-unified-en-0.6b-gguf";
const RECOMMENDED_FILE = "parakeet-unified-en-0.6b-Q8_0.gguf";

export type SttStatus = { ready: true; modelPath: string; modelId: string } | { ready: false; reason: string };

export function resolveSttModel(): SttStatus {
	const explicit = process.env.PPPI_STT_MODEL;
	if (explicit) {
		if (!existsSync(explicit)) return { ready: false, reason: `PPPI_STT_MODEL points to a missing file: ${explicit}` };
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
		reason: `no local STT model found. Run /transcribe once in pi (pi-transcribe) to download the recommended model (${RECOMMENDED_FILE}), or set PPPI_STT_MODEL=/path/to/model.gguf`,
	};
}

export class Stt {
	private model: TranscribeModelLike | null = null;
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
			this.model = (await mod.TranscribeModel.load(this.status.modelPath)) as TranscribeModelLike;
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

	/**
	 * Open a streaming utterance (interactive mode): feed PCM chunks as the user
	 * speaks, read committed/tentative partials, finalize on endpoint. Returns
	 * null when the loaded model has no streaming mode — callers fall back to
	 * batch transcribe().
	 */
	async openUtterance(): Promise<SttUtterance | null> {
		await this.ensureLoaded();
		const model = this.model!;
		if (!model.capabilities.supportsStreaming) return null;
		const session = model.createSession();
		try {
			// parakeet-unified's buffered streaming: the (L=5600, C=560, R=560)ms
			// operating point from the model's published menu — 1.12s lookahead,
			// full-accuracy finals, live committed text ~1.6s into an utterance.
			// Other streaming families (moonshine, voxtral, …) take no family
			// extension, so fall back to a plain stream.
			let stream: TranscribeStreamLike;
			try {
				stream = await session.stream({
					family: { kind: "parakeet_buffered", leftMs: 5600, chunkMs: 560, rightMs: 560 },
				});
			} catch {
				stream = await session.stream();
			}
			return new TranscribeUtterance(session, stream);
		} catch (err) {
			session.dispose();
			throw err;
		}
	}

	async dispose(): Promise<void> {
		this.model?.dispose?.();
		this.model = null;
		this.loading = null;
	}
}

/** One streaming utterance; structurally compatible with voice.ts's UtteranceStream. */
export type SttUtterance = {
	feed(pcm: Float32Array): Promise<{ committed: string; tentative: string }>;
	finalize(): Promise<string>;
	dispose(): void;
};

// transcribe-cpp surface we rely on (koffi-backed; typed here to keep stt.ts standalone)
type StreamTextLike = { full: string; committed: string; tentative: string };
type TranscribeStreamLike = {
	feed(pcm: Float32Array): Promise<unknown>;
	finalize(): Promise<unknown>;
	readonly text: StreamTextLike;
	reset(): void;
};
type TranscribeSessionLike = {
	stream(opts?: Record<string, unknown>): Promise<TranscribeStreamLike>;
	dispose(): void;
};
type TranscribeModelLike = {
	transcribe(pcm: Float32Array, opts?: Record<string, unknown>): Promise<{ text: string }>;
	createSession(opts?: Record<string, unknown>): TranscribeSessionLike;
	capabilities: { supportsStreaming: boolean };
	dispose?(): void;
};

/**
 * One spoken utterance over transcribe-cpp's streaming API. Feeds are
 * serialized (the native side decodes on a worker thread; overlapping feeds
 * could reorder audio), and partials ride along with each feed's snapshot.
 */
class TranscribeUtterance implements SttUtterance {
	private queue: Promise<void> = Promise.resolve();
	private text: StreamTextLike = { full: "", committed: "", tentative: "" };
	private done = false;

	constructor(
		private readonly session: TranscribeSessionLike,
		private readonly stream: TranscribeStreamLike,
	) {}

	async feed(pcm: Float32Array): Promise<{ committed: string; tentative: string }> {
		const run = this.queue.then(async () => {
			if (this.done) return;
			await this.stream.feed(pcm);
			this.text = this.stream.text;
		});
		this.queue = run.catch(() => undefined);
		await run;
		return { committed: this.text.committed, tentative: this.text.tentative };
	}

	async finalize(): Promise<string> {
		await this.queue;
		this.done = true;
		await this.stream.finalize();
		return this.stream.text.full;
	}

	dispose(): void {
		this.done = true;
		try {
			this.stream.reset();
		} catch {
			// already failed
		}
		this.session.dispose();
	}
}
