// Voice activity detection + turn endpointing for interactive mode.
//
// Silero VAD v5 (ONNX, MIT) runs on onnxruntime-node in fixed 512-sample
// (32 ms @16 kHz) windows; the exported graph requires exactly that window
// size. On top of it, UtteranceDetector is the pure turn-taking state machine
// from docs/plan/interactive-mode.md: pre-roll, sustained-speech start,
// silence endpoint, grace-period merge, and echo-aware barge-in while the
// agent's TTS is playing (the server knows playback state, which is why VAD
// lives here and not on the client).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";

export const VAD_WINDOW_SAMPLES = 512; // 32 ms @ 16 kHz

export class SileroVad {
	private session: ort.InferenceSession;
	private state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
	private sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);

	private constructor(session: ort.InferenceSession) {
		this.session = session;
	}

	static async create(modelPath?: string): Promise<SileroVad> {
		const path = modelPath ?? defaultModelPath();
		const session = await ort.InferenceSession.create(path);
		return new SileroVad(session);
	}

	/** Speech probability for one 512-sample window @16 kHz. */
	async prob(window: Float32Array): Promise<number> {
		if (window.length !== VAD_WINDOW_SAMPLES) throw new Error(`vad window must be ${VAD_WINDOW_SAMPLES} samples`);
		const input = new ort.Tensor("float32", Float32Array.from(window), [1, window.length]);
		const out = await this.session.run({ input, state: this.state, sr: this.sr });
		this.state = out.stateN as ort.Tensor;
		return out.output.data[0] ?? 0;
	}

	reset(): void {
		this.state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
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
};

export const DEFAULT_TIMINGS: VadTimings = {
	startMs: 150,
	endSilenceMs: 650,
	graceMs: 400,
	minUtteranceMs: 300,
	maxUtteranceMs: 25_000,
	bargeInMs: 400,
	ttsMuteMs: 200,
	threshold: 0.5,
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
	private speechSince = 0;
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
		if (this.phase === "grace" && nowMs >= this.graceUntil) {
			this.phase = "idle";
			this.events.onGraceExpired();
		}
		if (this.ttsPlaying && nowMs - this.ttsSince < this.timings.ttsMuteMs) return;

		const speaking = prob >= this.timings.threshold;
		const requiredMs = this.ttsPlaying ? this.timings.bargeInMs : this.timings.startMs;

		if (speaking) {
			if (!this.speechSince) this.speechSince = nowMs;
			if (this.phase === "open") this.lastSpeechAt = nowMs;
			const sustained = nowMs - this.speechSince >= requiredMs;
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
			this.speechSince = 0;
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
		this.speechSince = 0;
		this.bargeInFired = false;
		if (playing) this.ttsSince = nowMs;
	}
}
