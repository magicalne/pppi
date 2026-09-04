// Interactive voice sessions (ws /voice): one VoiceSession per connected mic.
//
// The client streams raw PCM16 16 kHz mono continuously while the session is
// open and sends nothing but hello/interrupt. THIS side owns the models and
// the turn-taking: silero VAD (32 ms windows) feeds UtteranceDetector
// (pre-roll → sustained-speech open → silence endpoint → grace merge →
// dispatch), echo-aware because the server knows when TTS is playing.
// STT is transcribe-cpp streaming (partials as the user speaks), replies are
// spoken by the TTS provider, and barge-in ("talking over the agent") aborts
// synthesis + the in-flight agent turn. See docs/plan/interactive-mode.md.

import { randomUUID } from "node:crypto";
import type { VoiceServerEvent } from "@sspi/protocol";
import type { WebSocket } from "ws";
import type { Stt } from "./stt.ts";
import { DEFAULT_TIMINGS, UtteranceDetector, type VadTimings } from "./vad.ts";

// ---------------------------------------------------------------- provider ports

/** Streaming utterance: feed PCM, read committed/tentative text, finalize. */
export interface UtteranceStream {
	feed(pcm: Float32Array): Promise<{ committed: string; tentative: string }>;
	finalize(): Promise<string>;
	dispose(): void;
}

export type VoiceSttStatus = { ready: true; modelId: string } | { ready: false; reason: string };

/** STT port for voice sessions — streaming when the model supports it, batch otherwise. */
export interface VoiceStt {
	readonly status: VoiceSttStatus;
	/** Open a streaming utterance, or null when only the batch path is available. */
	openUtterance(): Promise<UtteranceStream | null>;
	/** Batch fallback: transcribe one whole buffered utterance. */
	transcribeBuffer(pcm: Float32Array): Promise<string>;
}

export type VoiceTtsStatus = { ready: true; provider: string; voice: string } | { ready: false; reason: string };

/** TTS port: one prose chunk → async stream of PCM16 buffers at their native rate. */
export interface VoiceTts {
	readonly status: VoiceTtsStatus;
	synthesize(text: string): AsyncIterable<{ pcm: Buffer; rate: number }>;
}

/** Adapter: the shared Stt (streaming when the model supports it, batch otherwise) as the VoiceStt port. */
export function voiceStt(stt: Stt): VoiceStt {
	return {
		status: stt.status.ready
			? { ready: true, modelId: stt.status.modelId }
			: { ready: false, reason: stt.status.reason },
		openUtterance: () => stt.openUtterance(),
		transcribeBuffer: (pcm) => stt.transcribe({ sampleRate: 16000, channels: 1, samples: pcm }),
	};
}

// ---------------------------------------------------------------- session

export type VoiceSessionDeps = {
	token: string;
	stt: VoiceStt;
	tts: VoiceTts | null;
	/** anything with a per-window speech probability — SileroVad in prod, scripts in tests */
	vad: { prob(window: Float32Array): Promise<number> };
	timings?: Partial<VadTimings>;
	/** Submit a finalized utterance into the conversation. */
	submit(text: string): Promise<void>;
	/** Barge-in: abort the in-flight agent turn. */
	abortAgent(): void;
	/** Lifecycle: the server counts authed sessions and mirrors `voice_active` to chat clients. */
	onAuthed(): void;
	onClosed(): void;
	/** Sent when the session dies abnormally (for logging/tests). */
	onGone?: (reason: string) => void;
};

const HELLO_TIMEOUT_MS = 10_000;
const PRE_ROLL_MS = 300;
const SAMPLE_RATE = 16_000;
const VAD_WINDOW_SAMPLES = 512; // 32 ms @ 16 kHz

/** Control phrases act immediately and never become turns (plan D1: keywords command, silence ends turns). */
const CONTROL_PHRASES = /^(stop|cancel|abort|never\s?mind|forget it|scratch that)\s*[.!,?]*$/i;

type Capture = {
	pcm: Float32Array[];
	samples: number;
	fed: number;
	stream: UtteranceStream | null;
	opening: Promise<void>;
	/** endpointed, inside the grace window — may still merge or dispatch */
	pending: boolean;
};

export class VoiceSession {
	private authed = false;
	private helloTimer: NodeJS.Timeout | undefined;
	private closed = false;
	private readonly speaker: Speaker | null;
	private readonly detector: UtteranceDetector;
	private readonly timings: VadTimings;

	// audio path state
	private audioMs = 0; // audio-time clock (immune to processing/wall-clock jitter)
	private windowBuf = new Float32Array(0); // samples awaiting a full VAD window
	private vadBusy = Promise.resolve(); // serialize VAD window processing
	private preRoll: Float32Array[] = [];
	private preRollSamples = 0;
	private capture: Capture | null = null;

	constructor(
		private readonly ws: WebSocket,
		private readonly deps: VoiceSessionDeps,
	) {
		this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
		this.speaker = deps.tts
			? new Speaker(
					deps.tts,
					(c) => this.sendBinary(c),
					(e) => this.send(e),
					(playing) => this.detector.noteTts(playing, this.audioMs),
				)
			: null;
		this.detector = new UtteranceDetector(this.timings, {
			onSpeechStart: (merged) => this.onSpeechStart(merged),
			onSpeechEnd: (totalMs) => this.onSpeechEnd(totalMs),
			onGraceExpired: () => void this.dispatchCapture(),
			onBargeIn: () => {
				// talking over the agent: stop synthesis + agent NOW; the open
				// capture becomes the next user turn when it endpoints
				this.speaker?.abort();
				this.deps.abortAgent();
			},
		});
		this.helloTimer = setTimeout(() => this.close("hello timeout"), HELLO_TIMEOUT_MS);
		ws.on("message", (data: Buffer, isBinary: boolean) => {
			void this.onMessage(data, isBinary);
		});
		ws.on("close", () => this.onClose("client closed"));
		ws.on("error", () => this.onClose("socket error"));
	}

	// ------------------------------------------------------------- transport

	private send(evt: VoiceServerEvent): void {
		if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(evt));
	}

	private sendBinary(data: Buffer): void {
		if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(data, { binary: true });
	}

	private close(reason: string): void {
		this.onClose(reason);
		try {
			this.ws.close();
		} catch {
			// already gone
		}
	}

	private onClose(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.helloTimer);
		this.capture?.stream?.dispose();
		this.capture = null;
		this.speaker?.abort();
		if (this.authed) this.deps.onClosed();
		this.deps.onGone?.(reason);
	}

	private async onMessage(data: Buffer, isBinary: boolean): Promise<void> {
		if (isBinary) {
			if (this.authed) this.onAudio(data);
			return;
		}
		let msg: { type?: string; token?: string };
		try {
			msg = JSON.parse(data.toString()) as { type?: string; token?: string };
		} catch {
			return;
		}
		if (!this.authed) {
			if (msg.type !== "hello") return this.close("expected hello");
			clearTimeout(this.helloTimer);
			if ((msg.token ?? "") !== this.deps.token) {
				this.send({ type: "voice_hello_fail", error: "bad pairing token" });
				return this.close("bad token");
			}
			this.authed = true;
			this.deps.onAuthed();
			this.send({
				type: "voice_hello_ok",
				stt: this.deps.stt.status,
				tts: this.deps.tts?.status ?? { ready: false, reason: "no tts provider" },
			});
			this.send({ type: "voice_state", state: "listening" });
			return;
		}
		switch (msg.type) {
			case "interrupt":
				this.interrupt();
				break;
			case "playback_done":
				// the client's speaker is idle — barge-in thresholds can relax
				this.detector.noteTts(false, this.audioMs);
				break;
			default:
				break;
		}
	}

	// ------------------------------------------------------------- audio path

	private onAudio(data: Buffer): void {
		const frames = data.length >> 1;
		const pcm = new Float32Array(frames);
		for (let i = 0; i < frames; i++) pcm[i] = data.readInt16LE(i * 2) / 32768;

		if (this.capture) {
			this.appendCapture(pcm);
		} else {
			this.preRoll.push(pcm);
			this.preRollSamples += frames;
			const cap = (PRE_ROLL_MS * SAMPLE_RATE) / 1000;
			while (this.preRollSamples > cap && this.preRoll.length > 1) {
				const dropped = this.preRoll.shift()!;
				this.preRollSamples -= dropped.length;
			}
		}

		// VAD runs per 512-sample window, serialized to keep order
		this.windowBuf = concat(this.windowBuf, pcm);
		this.vadBusy = this.vadBusy
			.then(() => this.runVadWindows())
			.catch((err) => {
				if (process.env.DBG) console.error("DBG vad chain error:", err);
				this.send({ type: "voice_error", message: `vad: ${String((err as Error).message ?? err)}` });
			});
	}

	private async runVadWindows(): Promise<void> {
		const windowMs = (VAD_WINDOW_SAMPLES / SAMPLE_RATE) * 1000; // 32 ms
		while (this.windowBuf.length >= VAD_WINDOW_SAMPLES && !this.closed) {
			const win = this.windowBuf.subarray(0, VAD_WINDOW_SAMPLES);
			this.windowBuf = this.windowBuf.slice(VAD_WINDOW_SAMPLES);
			let prob = 0;
			try {
				prob = await this.deps.vad.prob(win);
			} catch {
				continue; // one bad window shouldn't kill the session
			}
			this.audioMs += windowMs;
			this.detector.feed(prob, this.audioMs);
		}
	}

	private appendCapture(pcm: Float32Array): void {
		const cap = this.capture!;
		cap.pcm.push(pcm);
		cap.samples += pcm.length;
		this.pumpStream(cap);
	}

	private pumpStream(cap: Capture): void {
		const stream = cap.stream;
		if (!stream) return;
		while (cap.fed < cap.pcm.length) {
			const pcm = cap.pcm[cap.fed++]!;
			void stream.feed(pcm).then(
				({ committed, tentative }) => this.send({ type: "stt_partial", committed, tentative }),
				() => this.send({ type: "voice_error", message: "stt stream failed" }),
			);
		}
	}

	// ------------------------------------------------------------- turn events

	private onSpeechStart(merged: boolean): void {
		if (merged && this.capture) return; // same capture continues
		const seeded = this.preRoll;
		const seededSamples = this.preRollSamples;
		this.preRoll = [];
		this.preRollSamples = 0;
		const cap: Capture = {
			pcm: seeded,
			samples: seededSamples,
			fed: 0,
			stream: null,
			opening: Promise.resolve(),
			pending: false,
		};
		this.capture = cap;
		cap.opening = (async () => {
			try {
				cap.stream = await this.deps.stt.openUtterance();
				this.pumpStream(cap); // pre-roll that buffered while the stream opened
			} catch (err) {
				this.send({ type: "voice_error", message: `stt: ${String((err as Error).message ?? err)}` });
			}
		})();
		this.send({ type: "vad", speaking: true });
	}

	private onSpeechEnd(totalMs: number): void {
		this.send({ type: "vad", speaking: false });
		if (!this.capture) return;
		if (totalMs === 0) {
			// blip — discard, back to idle
			this.capture.stream?.dispose();
			this.capture = null;
			return;
		}
		this.capture.pending = true; // grace window: may merge or dispatch
	}

	private async dispatchCapture(): Promise<void> {
		const cap = this.capture;
		this.capture = null;
		if (!cap) return;
		try {
			await cap.opening; // stream may still be opening
			this.pumpStream(cap);
			let text = "";
			if (cap.stream) text = await cap.stream.finalize();
			else text = await this.deps.stt.transcribeBuffer(concatAll(cap.pcm, cap.samples));
			cap.stream?.dispose();
			text = text.trim();
			if (text) await this.dispatchUtterance(text);
		} catch (err) {
			this.send({ type: "voice_error", message: String((err as Error).message ?? err) });
		}
	}

	private async dispatchUtterance(text: string): Promise<void> {
		// "stop" while the agent talks: abort now, no turn, back to listening
		if (CONTROL_PHRASES.test(text)) {
			this.send({ type: "stt_final", id: randomUUID(), text });
			this.send({ type: "voice_state", state: "listening" });
			this.interrupt();
			return;
		}
		const id = randomUUID();
		this.send({ type: "stt_final", id, text });
		this.send({ type: "voice_state", state: "thinking" });
		this.speaker?.beginTurn();
		try {
			await this.deps.submit(text);
		} catch (err) {
			this.send({ type: "voice_error", message: String((err as Error).message ?? err) });
		}
		// With TTS the speaking/listening states are driven by the speaker's
		// tts_start/tts_end; without it the turn ends when submission does.
		if (!this.deps.tts) this.send({ type: "voice_state", state: "listening" });
	}

	/** Barge-in: stop talking NOW, abort the agent. */
	interrupt(): void {
		this.speaker?.abort();
		this.deps.abortAgent();
	}

	/** Assistant text is streaming in (omni conversation) — speak it sentence by sentence. */
	assistantDelta(id: string, delta: string): void {
		this.speaker?.assistantDelta(id, delta);
	}

	/** Assistant turn finalized — speak the tail the deltas didn't cover. */
	assistantFinal(id: string, text: string): void {
		this.speaker?.assistantFinal(id, text);
	}

	/** Directly feed VAD probabilities (tests; bypasses the model). */
	feedProbability(prob: number, advanceMs = 32): void {
		this.audioMs += advanceMs;
		this.detector.feed(prob, this.audioMs);
	}
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
	const out = new Float32Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

function concatAll(chunks: Float32Array[], total: number): Float32Array {
	const out = new Float32Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

// ---------------------------------------------------------------- speaking

/**
 * Turns the assistant's streamed text into spoken audio: sentence chunking on
 * the way in (first audio leaves ~as soon as the first sentence forms), FIFO
 * queue, tts_start/binary/tts_end framing, and hard abort on barge-in.
 */
export class Speaker {
	private queue: Array<{ id: string; text: string }> = [];
	private draining = false;
	private aborted = false;
	private everStarted = false;
	private interruptedSent = false;
	private lastStartedId: string | null = null;
	/** per assistant message: how much of its final text has been enqueued */
	private chunker = { id: "", pending: "", emitted: "" };

	constructor(
		private readonly tts: VoiceTts,
		private readonly sendBinary: (chunk: Buffer) => void,
		private readonly sendEvent: (evt: VoiceServerEvent) => void,
		private readonly onPlayback?: (playing: boolean) => void,
	) {}

	/** A new user turn is going out — speaking may resume. */
	beginTurn(): void {
		this.aborted = false;
		this.everStarted = false;
		this.interruptedSent = false;
		this.lastStartedId = null;
	}

	assistantDelta(id: string, delta: string): void {
		if (this.chunker.id !== id) this.chunker = { id, pending: "", emitted: "" };
		this.chunker.pending += delta;
		// an unclosed code fence isn't prose yet — hold until it closes
		if ((this.chunker.pending.match(/```/g)?.length ?? 0) % 2 === 1) return;
		const { sentences, rest } = takeSentences(this.chunker.pending);
		this.chunker.pending = rest;
		for (const s of sentences) this.enqueue(s);
	}

	assistantFinal(id: string, text: string): void {
		if (this.chunker.id !== id) return;
		if (!text.startsWith(this.chunker.emitted)) return; // rewritten mid-flight: the visible text is right, stay quiet
		const tail = text.slice(this.chunker.emitted.length).trim();
		if (tail) this.enqueue(tail);
	}

	private enqueue(text: string): void {
		const prose = speakProse(text);
		if (!prose) return;
		this.chunker.emitted += text;
		this.queue.push({ id: randomUUID(), text: prose });
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0 && !this.aborted) {
				const item = this.queue.shift()!;
				let started = false;
				for await (const chunk of this.tts.synthesize(item.text)) {
					if (this.aborted) break;
					if (!started) {
						this.lastStartedId = item.id;
						this.sendEvent({ type: "tts_start", id: item.id, rate: chunk.rate });
						this.sendEvent({ type: "voice_state", state: "speaking" });
						this.onPlayback?.(true); // stays on until the client reports playback_done
						started = true;
						this.everStarted = true;
					}
					this.sendBinary(chunk.pcm);
				}
				if (started && this.aborted) {
					this.emitInterruptedEnd();
				} else if (started) {
					this.sendEvent({ type: "tts_end", id: item.id });
					if (this.queue.length === 0) this.sendEvent({ type: "voice_state", state: "listening" });
				}
			}
		} catch (err) {
			this.sendEvent({ type: "voice_error", message: `tts: ${String((err as Error).message ?? err)}` });
			this.sendEvent({ type: "voice_state", state: "listening" });
		} finally {
			this.queue.length = 0;
			this.draining = false;
		}
	}

	/**
	 * Barge-in: drop the queue, stop the in-flight synthesis between chunks,
	 * and tell the client its playback was cut — whether the cut lands
	 * mid-synthesis or between sentences (one interrupted tts_end, ever).
	 */
	abort(): void {
		if (this.aborted) return;
		this.aborted = true;
		this.queue.length = 0;
		if (this.everStarted && !this.interruptedSent) this.emitInterruptedEnd();
	}

	private emitInterruptedEnd(): void {
		this.interruptedSent = true;
		this.sendEvent({ type: "tts_end", id: this.lastStartedId ?? "", interrupted: true });
		this.sendEvent({ type: "voice_state", state: "listening" });
		this.onPlayback?.(false);
	}
}

/** Pull complete sentences off the front of the accumulating text. */
export function takeSentences(buf: string): { sentences: string[]; rest: string } {
	const sentences: string[] = [];
	let start = 0;
	for (;;) {
		const m = /[.!?…](?=\s|$)/.exec(buf.slice(start));
		if (!m) break;
		const end = start + m.index + m[0].length;
		const candidate = buf.slice(start, end).trim();
		sentences.push(candidate);
		start = end;
	}
	return { sentences, rest: buf.slice(start) };
}

/**
 * Markdown / code → speakable prose. A coding agent's raw answer is garbage
 * out loud: fences become a pointer at the screen, links and styling vanish.
 */
export function speakProse(text: string): string {
	let t = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) =>
		String(code).trim() ? " Code is on the screen. " : " ",
	);
	t = t.replace(/`([^`\n]+)`/g, "$1");
	t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	t = t.replace(/https?:\/\/\S+/g, " a link ");
	t = t.replace(/^#{1,6}\s+/gm, "");
	t = t.replace(/^\s*[-*+]\s+/gm, "");
	t = t.replace(/^\s*>\s?/gm, "");
	t = t.replace(/(\*\*|__)(.*?)\1/g, "$2");
	t = t.replace(/(\*|_)([^*_\n]+)\1/g, "$2");
	t = t.replace(/\s+/g, " ").trim();
	return t;
}
