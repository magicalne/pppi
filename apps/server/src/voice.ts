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

/** Control phrases act immediately and never become turns (plan D1: keywords command, silence ends turns). */
const CONTROL_PHRASES = /^(stop|cancel|abort|never\s?mind|forget it|scratch that)\s*[.!,?]*$/i;

type Utterance = {
	pcm: Float32Array[];
	samples: number;
	/** how many buffered chunks have been handed to the stream */
	fed: number;
	stream: UtteranceStream | null;
	/** resolves once openUtterance() settles (stream may be null = batch fallback) */
	opening: Promise<void>;
	startedAt: number;
	finalizing: boolean;
};

export class VoiceSession {
	private authed = false;
	private utterance: Utterance | null = null;
	private helloTimer: NodeJS.Timeout | undefined;
	private maxTimer: NodeJS.Timeout | undefined;
	private closed = false;
	private readonly speaker: Speaker | null;

	constructor(
		private readonly ws: WebSocket,
		private readonly deps: VoiceSessionDeps,
	) {
		this.speaker = deps.tts
			? new Speaker(
					deps.tts,
					(c) => this.sendBinary(c),
					(e) => this.send(e),
				)
			: null;
		this.helloTimer = setTimeout(() => this.close("hello timeout"), HELLO_TIMEOUT_MS);
		ws.on("message", (data: Buffer, isBinary: boolean) => {
			void this.onMessage(data, isBinary);
		});
		ws.on("close", () => this.onClose("client closed"));
		ws.on("error", () => this.onClose("socket error"));
	}

	/** Assistant text is streaming in (omni conversation) — speak it sentence by sentence. */
	assistantDelta(id: string, delta: string): void {
		this.speaker?.assistantDelta(id, delta);
	}

	/** Assistant turn finalized — speak the tail the deltas didn't cover. */
	assistantFinal(id: string, text: string): void {
		this.speaker?.assistantFinal(id, text);
	}

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
		clearTimeout(this.maxTimer);
		this.utterance?.stream?.dispose();
		this.utterance = null;
		this.speaker?.abort();
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
		const utt: Utterance = {
			pcm: [],
			samples: 0,
			fed: 0,
			stream: null,
			opening: Promise.resolve(),
			startedAt: Date.now(),
			finalizing: false,
		};
		this.utterance = utt;
		this.send({ type: "voice_state", state: "listening" });
		utt.opening = (async () => {
			try {
				utt.stream = await this.deps.stt.openUtterance();
				this.pumpStream(utt); // chunks that arrived while the stream was opening
			} catch (err) {
				this.send({ type: "voice_error", message: `stt: ${String((err as Error).message ?? err)}` });
			}
		})();
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
		this.pumpStream(utt);
	}

	/** Feed every buffered-but-unfed chunk to the open stream; partials ride along. */
	private pumpStream(utt: Utterance): void {
		const stream = utt.stream;
		if (!stream) return;
		while (utt.fed < utt.pcm.length) {
			const pcm = utt.pcm[utt.fed++]!;
			void stream.feed(pcm).then(
				({ committed, tentative }) => this.send({ type: "stt_partial", committed, tentative }),
				() => this.send({ type: "voice_error", message: "stt stream failed" }),
			);
		}
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
			await utt.opening; // the stream may still be opening when speech_end races in
			this.pumpStream(utt);
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
	/** per assistant message: how much of its final text has been enqueued */
	private chunker = { id: "", pending: "", emitted: "" };

	constructor(
		private readonly tts: VoiceTts,
		private readonly sendBinary: (chunk: Buffer) => void,
		private readonly sendEvent: (evt: VoiceServerEvent) => void,
	) {}

	/** A new user turn is going out — speaking may resume. */
	beginTurn(): void {
		this.aborted = false;
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
						this.sendEvent({ type: "tts_start", id: item.id, rate: chunk.rate });
						this.sendEvent({ type: "voice_state", state: "speaking" });
						started = true;
					}
					this.sendBinary(chunk.pcm);
				}
				if (started) {
					this.sendEvent({ type: "tts_end", id: item.id, interrupted: this.aborted || undefined });
					this.sendEvent({ type: "voice_state", state: "listening" });
				} else if (this.aborted) {
					this.sendEvent({ type: "voice_state", state: "listening" });
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

	/** Barge-in: drop the queue, stop the in-flight synthesis between chunks. */
	abort(): void {
		this.aborted = true;
		this.queue.length = 0;
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
