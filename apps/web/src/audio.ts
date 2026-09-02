// Microphone → 16 kHz mono PCM16 WAV. Records at whatever the browser gives
// us, then downsamples; clients stay small and the server stays forgiving.

export type Recording = { wav: Blob; durationMs: number };

export class VoiceRecorder {
	private stream: MediaStream | null = null;
	private ctx: AudioContext | null = null;
	private processor: ScriptProcessorNode | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private chunks: Float32Array[] = [];
	private totalFrames = 0;
	private inputRate = 48000;
	startedAt = 0;

	onLevel: ((level: number) => void) | null = null;

	async start(): Promise<void> {
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
		});
		this.ctx = new AudioContext();
		this.inputRate = this.ctx.sampleRate;
		this.source = this.ctx.createMediaStreamSource(this.stream);
		this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
		this.chunks = [];
		this.totalFrames = 0;
		this.processor.onaudioprocess = (e) => {
			const input = e.inputBuffer.getChannelData(0);
			this.chunks.push(new Float32Array(input));
			this.totalFrames += input.length;
			if (this.onLevel) {
				let acc = 0;
				for (let i = 0; i < input.length; i++) acc += (input[i] ?? 0) * (input[i] ?? 0);
				this.onLevel(Math.sqrt(acc / input.length));
			}
		};
		this.source.connect(this.processor);
		this.processor.connect(this.ctx.destination);
		this.startedAt = Date.now();
	}

	get durationMs(): number {
		return Date.now() - this.startedAt;
	}

	async stop(): Promise<Recording> {
		if (this.processor) this.processor.onaudioprocess = null;
		this.source?.disconnect();
		this.processor?.disconnect();
		await this.ctx?.close();
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = null;
		this.ctx = null;

		const merged = new Float32Array(this.totalFrames);
		let off = 0;
		for (const c of this.chunks) {
			merged.set(c, off);
			off += c.length;
		}
		const mono16k = downsample(merged, this.inputRate, 16000);
		const durationMs = (mono16k.length / 16000) * 1000;
		return { wav: encodeWav(mono16k), durationMs };
	}
}

function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate) return input;
	const ratio = toRate / fromRate;
	const out = new Float32Array(Math.floor(input.length * ratio));
	for (let i = 0; i < out.length; i++) {
		const src = i / ratio;
		const i0 = Math.floor(src);
		const i1 = Math.min(i0 + 1, input.length - 1);
		const frac = src - i0;
		out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
	}
	return out;
}

function encodeWav(samples: Float32Array): Blob {
	const buffer = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(buffer);
	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
	};
	writeStr(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, 16000, true);
	view.setUint32(28, 32000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeStr(36, "data");
	view.setUint32(40, samples.length * 2, true);
	let off = 44;
	for (let i = 0; i < samples.length; i++, off += 2) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		view.setInt16(off, Math.round(s * 32767), true);
	}
	return new Blob([buffer], { type: "audio/wav" });
}
