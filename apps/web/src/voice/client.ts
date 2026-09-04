// Voice websocket client: hello/token auth, continuous 16 kHz PCM16 uplink,
// server events down (vad turns, stt partials, tts audio framing).

import type { VoiceServerEvent } from "@sspi/protocol";
import type { MicStream } from "./mic.ts";

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
			const guard = setTimeout(() => reject(new Error("voice handshake timed out")), 10_000);
			ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: this.token, client: "web" }));
			ws.onmessage = (m) => {
				if (typeof m.data === "string") {
					const evt = JSON.parse(m.data) as VoiceServerEvent;
					if (evt.type === "voice_hello_ok") {
						clearTimeout(guard);
						this.live = true;
						resolve();
					} else if (evt.type === "voice_hello_fail") {
						clearTimeout(guard);
						reject(new Error(evt.error));
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
				clearTimeout(guard);
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
		if (this.live && this.ws?.readyState === this.ws.OPEN) {
			this.ws.send(JSON.stringify({ type: "interrupt" }));
		}
	}

	/** The local speaker went idle — relax the server's echo-aware barge-in. */
	playbackDone(): void {
		if (this.live && this.ws?.readyState === this.ws.OPEN) {
			this.ws.send(JSON.stringify({ type: "playback_done" }));
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
