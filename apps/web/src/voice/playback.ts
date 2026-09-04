// Streaming TTS playback: PCM16 chunks arrive over the voice websocket and
// queue into consecutive AudioBufferSourceNodes. stopAll() fades the gain in
// ~80 ms — barge-in should sound like a person being interrupted, not a click.

export class TtsPlayer {
	private ctx: AudioContext | null = null;
	private gain: GainNode | null = null;
	private queue: Array<{ buffer: AudioBuffer; rate: number }> = [];
	private playing: AudioBufferSourceNode | null = null;
	private idleResolve: (() => void) | null = null;

	/** Append one s16le PCM chunk. First chunk of an utterance carries its rate. */
	play(pcm: ArrayBuffer, rate: number): void {
		const ctx = this.ensure();
		const samples = Math.floor(pcm.byteLength / 2);
		if (samples === 0) return;
		const audio = new Float32Array(samples);
		const view = new DataView(pcm);
		for (let i = 0; i < samples; i++) audio[i] = view.getInt16(i * 2, true) / 32768;
		const buffer = ctx.createBuffer(1, samples, rate);
		buffer.copyToChannel(audio, 0);
		this.queue.push({ buffer, rate });
		if (!this.playing) this.startNext();
	}

	/** Resolves when everything queued has finished playing (or was stopped). */
	async waitIdle(): Promise<void> {
		if (!this.playing && this.queue.length === 0) return;
		await new Promise<void>((r) => {
			this.idleResolve = r;
		});
	}

	/** Barge-in: drop the queue and fade out whatever is playing. */
	stopAll(): void {
		this.queue = [];
		const node = this.playing;
		const ctx = this.ctx;
		if (!node || !ctx) return;
		const now = ctx.currentTime;
		try {
			this.gain?.gain.cancelScheduledValues(now);
			this.gain?.gain.setValueAtTime(this.gain.gain.value, now);
			this.gain?.gain.linearRampToValueAtTime(0, now + 0.08);
		} catch {
			// gain already torn down
		}
		setTimeout(() => {
			try {
				node.stop();
			} catch {
				// already stopped
			}
		}, 90);
		this.playing = null;
	}

	async close(): Promise<void> {
		this.stopAll();
		this.gain?.disconnect();
		await this.ctx?.close();
		this.gain = null;
		this.ctx = null;
	}

	private ensure(): AudioContext {
		if (!this.ctx) {
			this.ctx = new AudioContext();
			this.gain = this.ctx.createGain();
			this.gain.connect(this.ctx.destination);
		}
		void this.ctx.resume();
		return this.ctx;
	}

	private startNext(): void {
		const ctx = this.ensure();
		const next = this.queue.shift();
		if (!next) {
			this.playing = null;
			this.idleResolve?.();
			this.idleResolve = null;
			return;
		}
		const node = ctx.createBufferSource();
		node.buffer = next.buffer;
		node.connect(this.gain!);
		// restore gain in case a barge-in fade just happened
		const now = ctx.currentTime;
		this.gain!.gain.cancelScheduledValues(now);
		this.gain!.gain.setValueAtTime(1, now);
		node.onended = () => this.startNext();
		this.playing = node;
		node.start();
	}
}
