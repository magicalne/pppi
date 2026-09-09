// Voice websocket client: hello/token auth, continuous 16 kHz PCM16 uplink,
// server events down (vad turns, stt partials, tts audio framing).

import type { VoiceServerEvent } from "@pppi/protocol";
import type { MicStream } from "./mic.ts";

/** Server boot progress, arrives as __voice_boot__ control frames (pre-hello). */
export type VoiceBootFrame = { component?: string; stage: string; reason?: string };

export type VoiceHandlers = {
	onState: (state: "listening" | "thinking" | "speaking") => void;
	onVad: (speaking: boolean) => void;
	onPartial: (committed: string, tentative: string) => void;
	onFinal: (text: string) => void;
	onTtsStart: (rate: number) => void;
	onTtsChunk: (pcm: ArrayBuffer) => void;
	onTtsEnd: (interrupted: boolean) => void;
	onError: (message: string) => void;
	onGone: () => void;
	onBoot?: (frame: VoiceBootFrame) => void;
};

export class VoiceClient {
	private ws: WebSocket | null = null;
	private mic: MicStream | null = null;
	private live = false;

	constructor(
		private readonly base: string,
		private readonly token: string,
		private readonly handlers: VoiceHandlers,
	) {}

	async start(mic: MicStream): Promise<void> {
		this.mic = mic;
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(`${this.base.replace(/^http/, "ws").replace(/\/$/, "")}/voice`);
			this.ws = ws;
			// boot frames keep pushing the deadline out — a warming server may
			// legitimately hold hello_ok for a while
			let guard: ReturnType<typeof setTimeout> | null = setTimeout(fail, 10_000);
			function fail() {
				guard = null;
				try {
					ws.close();
				} catch {
					// already gone
				}
				reject(new Error("voice handshake timed out"));
			}
			ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: this.token, client: "web" }));
			ws.onmessage = (m) => {
				if (typeof m.data === "string") {
					const evt = JSON.parse(m.data) as VoiceServerEvent;
					if (evt.type === "voice_hello_ok") {
						if (guard) clearTimeout(guard);
						this.live = true;
						resolve();
					} else if (evt.type === "voice_hello_fail") {
						if (guard) clearTimeout(guard);
						reject(new Error(evt.error));
					} else if ((evt as { type?: string }).type === "__voice_boot__") {
						// fires before hello_ok while the server loads its voice models
						if (guard) clearTimeout(guard);
						guard = setTimeout(fail, 90_000);
						this.handlers.onBoot?.(evt as unknown as VoiceBootFrame);
					} else {
						this.dispatch(evt);
					}
				} else {
					// binary frame = tts audio (rate announced by tts_start)
					this.handlers.onTtsChunk(m.data as ArrayBuffer);
				}
			};
			ws.onerror = () => {
				/* onclose follows */
			};
			ws.onclose = () => {
				if (guard) clearTimeout(guard);
				const wasLive = this.live;
				this.live = false;
				if (wasLive) this.handlers.onGone();
				else reject(new Error("voice socket closed before handshake"));
			};
		});
	}

	get active(): boolean {
		return this.live;
	}

	sendAudio(pcm: Float32Array): void {
		if (!this.live || !this.ws || this.ws.readyState !== this.ws.OPEN) return;
		const pcm16 = new Int16Array(pcm.length);
		for (let i = 0; i < pcm.length; i++) {
			const v = Math.max(-1, Math.min(1, pcm[i] ?? 0));
			pcm16[i] = Math.round(v * 32767);
		}
		this.ws.send(pcm16.buffer);
	}

	interrupt(): void {
		const sock = this.ws;
		if (this.live && sock && sock.readyState === sock.OPEN) {
			sock.send(JSON.stringify({ type: "interrupt" }));
		}
	}

	/** The local speaker went idle — relax the server's echo-aware barge-in. */
	playbackDone(): void {
		const sock = this.ws;
		if (this.live && sock && sock.readyState === sock.OPEN) {
			sock.send(JSON.stringify({ type: "playback_done" }));
		}
	}

	close(): void {
		this.live = false;
		this.ws?.close();
		this.ws = null;
	}

	private dispatch(evt: VoiceServerEvent): void {
		switch (evt.type) {
			case "voice_state":
				this.handlers.onState(evt.state);
				break;
			case "vad":
				this.handlers.onVad(evt.speaking);
				break;
			case "stt_partial":
				this.handlers.onPartial(evt.committed, evt.tentative);
				break;
			case "stt_final":
				this.handlers.onFinal(evt.text);
				break;
			case "tts_start":
				this.handlers.onTtsStart(evt.rate);
				break;
			case "tts_end":
				this.handlers.onTtsEnd(Boolean(evt.interrupted));
				break;
			case "voice_error":
				this.handlers.onError(evt.message);
				break;
			default:
				break;
		}
	}
}
