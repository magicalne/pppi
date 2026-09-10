// Voice activity detection + turn endpointing for interactive mode.
//
// Silero VAD v5 (ONNX, MIT) runs in a dedicated worker thread (see
// vadWorker.ts — sharing the main thread's ONNX runtime with the kokoro TTS
// stack deadlocks inference) in fixed 512-sample (32 ms @16 kHz) windows; the
// exported graph requires exactly that window size. On top of it,
// UtteranceDetector is the pure turn-taking state machine from
// docs/plan/interactive-mode.md: pre-roll, sustained-speech start, silence
// endpoint, grace-period merge, and echo-aware barge-in while the agent's TTS
// is playing (the server knows playback state, which is why VAD lives here
// and not on the client).

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const VAD_WINDOW_SAMPLES = 512; // 32 ms @ 16 kHz

export class SileroVad {
	private proc: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private pending = new Map<number, { resolve: (p: number) => void; reject: (e: Error) => void }>();

	private constructor(proc: ChildProcessWithoutNullStreams) {
		this.proc = proc;
		const rl = createInterface({ input: proc.stdout, terminal: false });
		rl.on("line", (line) => {
			let msg: { id?: number; prob?: number };
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (typeof msg.id === "number") {
				const entry = this.pending.get(msg.id);
				if (entry) {
					this.pending.delete(msg.id);
					entry.resolve(msg.prob ?? 0);
				}
			}
		});
		proc.on("error", (err) => {
			for (const [, entry] of this.pending) entry.reject(err);
			this.pending.clear();
		});
	}

	static async create(modelPath?: string): Promise<SileroVad> {
		const path = modelPath ?? defaultModelPath();
		const entry = join(dirname(fileURLToPath(import.meta.url)), "vadProcess.ts");
		const proc = spawn(process.execPath, [entry, path], {
			stdio: ["pipe", "pipe", "inherit"],
		}) as ChildProcessWithoutNullStreams;
		const vad = new SileroVad(proc);
		// one probe round-trip so callers fail fast if the model didn't load
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("vad process did not become ready")), 15_000);
			const onLine = (line: Buffer) => {
				if (line.toString().includes("ready")) {
					clearTimeout(timer);
					proc.stdout.off("data", onLine);
					resolve();
				}
			};
			proc.stdout.on("data", onLine);
			proc.on("exit", (code) => reject(new Error(`vad process exited ${code}`)));
		});
		await vad.prob(new Float32Array(VAD_WINDOW_SAMPLES));
		return vad;
	}

	/** Speech probability for one 512-sample window @16 kHz. */
	prob(window: Float32Array): Promise<number> {
		if (window.length !== VAD_WINDOW_SAMPLES)
			return Promise.reject(new Error(`vad window must be ${VAD_WINDOW_SAMPLES} samples`));
		const id = this.nextId++;
		return new Promise<number>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.proc.stdin.write(`${JSON.stringify({ id, type: "prob", pcm: Array.from(window) })}\n`);
		});
	}

	reset(): void {
		this.proc.stdin.write(`${JSON.stringify({ type: "reset" })}\n`);
	}

	dispose(): void {
		this.proc.kill();
	}
}

function defaultModelPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "silero_vad.onnx");
}

// ---------------------------------------------------------------- turn taking

export type VadTimings = {
	/** sustained speech before an utterance opens */
	startMs: number;
	/** silence that closes the utterance */
	endSilenceMs: number;
	/** after endpointing, speech may resume this long and merge into the same turn */
	graceMs: number;
	/** utterances shorter than this are blips, not turns */
	minUtteranceMs: number;
	/** force-close long rambles */
	maxUtteranceMs: number;
	/** sustained speech that counts as barge-in while TTS plays */
	bargeInMs: number;
	/** ignore VAD this long after TTS starts (speaker attack transients) */
	ttsMuteMs: number;
	/** probability threshold for "speech" */
	threshold: number;
	/** sub-threshold gaps up to this long don't reset the sustain counters */
	gapToleranceMs: number;
};

export const DEFAULT_TIMINGS: VadTimings = {
	startMs: 150,
	endSilenceMs: 650,
	graceMs: 400,
	minUtteranceMs: 300,
	maxUtteranceMs: 25_000,
	bargeInMs: 250,
	ttsMuteMs: 200,
	threshold: 0.5,
	gapToleranceMs: 180,
};

export type DetectorEvents = {
	/** an utterance opened (or reopened during grace — same turn, merged) */
	onSpeechStart: (merged: boolean) => void;
	/** endpointing decided the turn is over (or was a blip: totalMs 0 = discard) */
	onSpeechEnd: (totalMs: number) => void;
	/** grace window expired with no resumed speech — dispatch what we have */
	onGraceExpired: () => void;
	/** user talked over the agent while TTS was playing */
	onBargeIn: () => void;
};

type Phase = "idle" | "open" | "grace";

/**
 * Turn-taking state machine over VAD probabilities. Feed once per 32 ms
 * window with a wall-clock timestamp; call noteTts() around TTS playback so
 * barge-in thresholds stay echo-aware.
 */
export class UtteranceDetector {
	private phase: Phase = "idle";
	private sustainStart = 0;
	private silenceSince = 0;
	private openAt = 0;
	private lastSpeechAt = 0;
	private graceUntil = 0;
	private ttsSince = 0;
	private ttsPlaying = false;
	private bargeInFired = false;

	constructor(
		private readonly timings: VadTimings,
		private readonly events: DetectorEvents,
	) {}

	/** is an utterance currently capturing audio? */
	get open(): boolean {
		return this.phase === "open";
	}

	feed(prob: number, nowMs: number): void {
		if (process.env.DBG)
			console.error(`DBG feed t=${nowMs} p=${prob.toFixed(2)} ph=${this.phase} tts=${this.ttsPlaying}`);

		if (this.phase === "grace" && nowMs >= this.graceUntil) {
			this.phase = "idle";
			this.events.onGraceExpired();
		}
		if (this.ttsPlaying && nowMs - this.ttsSince < this.timings.ttsMuteMs) return;

		const speaking = prob >= this.timings.threshold;
		const requiredMs = this.ttsPlaying ? this.timings.bargeInMs : this.timings.startMs;

		if (speaking) {
			// micro-gaps between words shouldn't reset the sustain counters
			if (nowMs - this.lastSpeechAt > this.timings.gapToleranceMs) this.sustainStart = nowMs;
			this.lastSpeechAt = nowMs;
			const sustained = nowMs - this.sustainStart >= requiredMs;
			if (sustained) {
				if (this.phase === "idle") {
					this.phase = "open";
					this.openAt = nowMs;
					this.lastSpeechAt = nowMs;
					this.events.onSpeechStart(false);
				} else if (this.phase === "grace") {
					this.phase = "open";
					this.events.onSpeechStart(true); // merged into the pending turn
				} else if (this.ttsPlaying && !this.bargeInFired) {
					this.bargeInFired = true;
					this.events.onBargeIn(); // talking over the agent
				}
			}
		} else {
			if (this.phase === "open") {
				if (!this.silenceSince) this.silenceSince = nowMs;
				if (nowMs - this.silenceSince >= this.timings.endSilenceMs) {
					const speechMs = this.lastSpeechAt - this.openAt;
					if (speechMs < this.timings.minUtteranceMs) {
						// blip (cough, keyboard) — back to idle, not a turn
						this.phase = "idle";
						this.events.onSpeechEnd(0);
					} else {
						this.phase = "grace";
						this.graceUntil = nowMs + this.timings.graceMs;
						this.events.onSpeechEnd(speechMs);
					}
					this.silenceSince = 0;
				}
			}
		}

		if (this.phase === "open" && nowMs - this.openAt >= this.timings.maxUtteranceMs) {
			// ramble cap — endpoint now (grace still applies for the merge)
			const speechMs = this.lastSpeechAt - this.openAt;
			this.phase = "grace";
			this.graceUntil = nowMs + this.timings.graceMs;
			this.events.onSpeechEnd(speechMs);
			this.silenceSince = 0;
		}
	}

	/** TTS playback state — makes barge-in thresholds echo-aware. */
	noteTts(playing: boolean, nowMs: number): void {
		if (playing === this.ttsPlaying) return;
		this.ttsPlaying = playing;
		this.sustainStart = 0;
		this.bargeInFired = false;
		if (playing) this.ttsSince = nowMs;
	}
}
