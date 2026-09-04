// Microphone capture for interactive mode: platform echo cancellation,
// noise suppression and AGC via getUserMedia constraints, resampled to
// 16 kHz mono and emitted as ~100 ms Float32 chunks.

export class MicStream {
	private stream: MediaStream | null = null;
	private ctx: AudioContext | null = null;
	private node: AudioWorkletNode | null = null;
	private tail = new Float32Array(0);
	private onChunk: ((pcm: Float32Array) => void) | null = null;
	private outRate = 16000;

	async start(onChunk: (pcm: Float32Array) => void): Promise<void> {
		this.onChunk = onChunk;
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		this.ctx = new AudioContext();
		await this.ctx.audioWorklet.addModule("/pcm-worklet.js");
		this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
		this.node.port.onmessage = (e) => this.accept(e.data as Float32Array);
		this.ctx.createMediaStreamSource(this.stream).connect(this.node);
		// no connection to destination: capture-only, no feedback loop
	}

	async stop(): Promise<void> {
		this.onChunk = null;
		this.node?.port.close();
		this.node?.disconnect();
		for (const t of this.stream?.getTracks() ?? []) t.stop();
		await this.ctx?.close();
		this.node = null;
		this.stream = null;
		this.ctx = null;
		this.tail = new Float32Array(0);
	}

	private accept(input: Float32Array): void {
		const handler = this.onChunk;
		if (!handler || !this.ctx) return;
		const resampled = downsample(input, this.ctx.sampleRate, this.outRate);
		const combined = concat(this.tail, resampled);
		const chunkSamples = 1600; // 100 ms @ 16 kHz
		let offset = 0;
		for (; offset + chunkSamples <= combined.length; offset += chunkSamples) {
			handler(combined.subarray(offset, offset + chunkSamples));
		}
		this.tail = combined.slice(offset);
	}
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
	const out = new Float32Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate) return input;
	const ratio = fromRate / toRate;
	const out = new Float32Array(Math.floor(input.length / ratio));
	for (let i = 0; i < out.length; i++) {
		const src = i * ratio;
		const i0 = Math.floor(src);
		const i1 = Math.min(i0 + 1, input.length - 1);
		const frac = src - i0;
		out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
	}
	return out;
}
