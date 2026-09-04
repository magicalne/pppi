// Interactive voice sessions (ws /voice): one VoiceSession per connected mic.
//
// Division of labor (docs/plan/interactive-mode.md): the client owns capture,
// VAD and endpointing — it brackets each utterance with speech_start /
// speech_end and streams raw PCM16 16 kHz mono frames in between. The server
// owns STT, the agent and TTS. Barge-in: the client stops playback locally on
// its own VAD and sends `interrupt`; the server aborts the agent and drains
// whatever TTS is in flight.

import { randomUUID } from "node:crypto";
import type { VoiceServerEvent } from "@sspi/protocol";
import type { WebSocket } from "ws";
import type { Stt } from "./stt.ts";

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

/** Adapter: the hold-to-talk batch Stt as a (non-streaming) VoiceStt. */
export function batchVoiceStt(stt: Stt): VoiceStt {
	return {
		status: stt.status.ready
			? { ready: true, modelId: stt.status.modelId }
			: { ready: false, reason: stt.status.reason },
		openUtterance: () => Promise.resolve(null),
		transcribeBuffer: (pcm) => stt.transcribe({ sampleRate: 16000, channels: 1, samples: pcm }),
	};
}

// ---------------------------------------------------------------- session

export type VoiceSessionDeps = {
	token: string;
	stt: VoiceStt;
	tts: VoiceTts | null;
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
const MIN_UTTERANCE_MS = 300;
const MAX_UTTERANCE_MS = 25_000;

type Utterance = {
	pcm: Float32Array[];
	samples: number;
	stream: UtteranceStream | null;
	startedAt: number;
	finalizing: boolean;
};

export class VoiceSession {
	private authed = false;
	private utterance: Utterance | null = null;
	private helloTimer: NodeJS.Timeout | undefined;
	private maxTimer: NodeJS.Timeout | undefined;
	private closed = false;

	constructor(
		private readonly ws: WebSocket,
		private readonly deps: VoiceSessionDeps,
	) {
		this.helloTimer = setTimeout(() => this.close("hello timeout"), HELLO_TIMEOUT_MS);
		ws.on("message", (data: Buffer, isBinary: boolean) => {
			void this.onMessage(data, isBinary);
		});
		ws.on("close", () => this.onClose("client closed"));
		ws.on("error", () => this.onClose("socket error"));
	}

	private send(evt: VoiceServerEvent): void {
		if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(evt));
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
		clearTimeout(this.maxTimer);
		this.utterance?.stream?.dispose();
		this.utterance = null;
		if (this.authed) this.deps.onClosed();
		this.deps.onGone?.(reason);
	}

	private async onMessage(data: Buffer, isBinary: boolean): Promise<void> {
		if (isBinary) {
			if (this.authed && this.utterance) this.feedAudio(data);
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
			return;
		}
		switch (msg.type) {
			case "speech_start":
				void this.startUtterance();
				break;
			case "speech_end":
				void this.endUtterance(false);
				break;
			case "interrupt":
				this.interrupt();
				break;
			default:
				break;
		}
	}

	// ------------------------------------------------------------- utterances

	private async startUtterance(): Promise<void> {
		if (this.utterance) return; // already open — ignore duplicate starts
		this.utterance = { pcm: [], samples: 0, stream: null, startedAt: Date.now(), finalizing: false };
		this.send({ type: "voice_state", state: "listening" });
		try {
			this.utterance.stream = await this.deps.stt.openUtterance();
		} catch (err) {
			this.send({ type: "voice_error", message: `stt: ${String((err as Error).message ?? err)}` });
		}
		clearTimeout(this.maxTimer);
		this.maxTimer = setTimeout(() => void this.endUtterance(true), MAX_UTTERANCE_MS);
	}

	private feedAudio(data: Buffer): void {
		const utt = this.utterance;
		if (!utt || utt.finalizing) return;
		const frames = data.length >> 1;
		const pcm = new Float32Array(frames);
		for (let i = 0; i < frames; i++) pcm[i] = data.readInt16LE(i * 2) / 32768;
		utt.pcm.push(pcm);
		utt.samples += frames;
		const stream = utt.stream;
		if (stream)
			void stream.feed(pcm).then(
				({ committed, tentative }) => this.send({ type: "stt_partial", committed, tentative }),
				() => this.send({ type: "voice_error", message: "stt stream failed" }),
			);
	}

	private async endUtterance(forced: boolean): Promise<void> {
		const utt = this.utterance;
		clearTimeout(this.maxTimer);
		if (!utt || utt.finalizing) return;
		utt.finalizing = true;
		const durationMs = (utt.samples / 16000) * 1000;
		if (durationMs < MIN_UTTERANCE_MS && !forced) {
			utt.stream?.dispose();
			this.utterance = null;
			this.send({ type: "voice_state", state: "listening" });
			return;
		}
		try {
			let text = "";
			if (utt.stream) text = await utt.stream.finalize();
			else text = await this.deps.stt.transcribeBuffer(concatPcm(utt.pcm, utt.samples));
			utt.stream?.dispose();
			this.utterance = null;
			text = text.trim();
			if (text) await this.dispatchUtterance(text);
			else this.send({ type: "voice_state", state: "listening" });
		} catch (err) {
			this.utterance = null;
			this.send({ type: "voice_error", message: String((err as Error).message ?? err) });
			this.send({ type: "voice_state", state: "listening" });
		}
	}

	private async dispatchUtterance(text: string): Promise<void> {
		const id = randomUUID();
		this.send({ type: "stt_final", id, text });
		this.send({ type: "voice_state", state: "thinking" });
		try {
			await this.deps.submit(text);
		} catch (err) {
			this.send({ type: "voice_error", message: String((err as Error).message ?? err) });
		}
		// With no TTS the turn ends when submission does; with TTS the
		// speaking/listening states are driven by tts_start/tts_end (Phase 2).
		if (!this.deps.tts) this.send({ type: "voice_state", state: "listening" });
	}

	/** Barge-in: abort the agent; TTS drain arrives with the provider wiring. */
	interrupt(): void {
		this.deps.abortAgent();
	}
}

function concatPcm(chunks: Float32Array[], total: number): Float32Array {
	const out = new Float32Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}
