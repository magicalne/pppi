// Minimal WAV (RIFF) parser → 16 kHz mono Float32 PCM for transcribe-cpp.
// Clients are expected to send 16 kHz mono PCM16 WAV; anything else that is
// valid PCM gets downmixed/resampled so the server stays forgiving.

export type DecodedWav = {
	sampleRate: number;
	channels: number;
	samples: Float32Array; // interleaved as-is; use toMono16k for model input
};

export class WavError extends Error {}

export function decodeWav(buf: Buffer): DecodedWav {
	if (buf.length < 44) throw new WavError("file too small to be a WAV");
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
		throw new WavError("not a RIFF/WAVE file");
	}

	let pos = 12;
	let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
	let data: Buffer | null = null;

	while (pos + 8 <= buf.length) {
		const id = buf.toString("ascii", pos, pos + 4);
		const size = buf.readUInt32LE(pos + 4);
		const body = pos + 8;
		if (id === "fmt ") {
			fmt = {
				audioFormat: buf.readUInt16LE(body),
				channels: buf.readUInt16LE(body + 2),
				sampleRate: buf.readUInt32LE(body + 4),
				bits: buf.readUInt16LE(body + 14),
			};
		} else if (id === "data") {
			data = buf.subarray(body, Math.min(body + size, buf.length));
			break;
		}
		pos = body + size + (size % 2); // chunks are word-aligned
	}

	if (!fmt) throw new WavError("missing fmt chunk");
	if (!data) throw new WavError("missing data chunk");
	if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) {
		throw new WavError(`unsupported WAV encoding ${fmt.audioFormat} (want PCM=1 or float=3)`);
	}
	if (fmt.channels < 1 || fmt.channels > 8) throw new WavError(`unsupported channel count ${fmt.channels}`);

	const bytesPerSample = fmt.bits / 8;
	const frames = Math.floor(data.length / (bytesPerSample * fmt.channels));
	const samples = new Float32Array(frames * fmt.channels);
	for (let i = 0; i < frames * fmt.channels; i++) {
		const off = i * bytesPerSample;
		if (fmt.bits === 16) samples[i] = data.readInt16LE(off) / 32768;
		else if (fmt.bits === 32 && fmt.audioFormat === 3) samples[i] = data.readFloatLE(off);
		else if (fmt.bits === 32 && fmt.audioFormat === 1) samples[i] = data.readInt32LE(off) / 2147483648;
		else if (fmt.bits === 8) samples[i] = (data.readUInt8(off) - 128) / 128;
		else if (fmt.bits === 24) {
			const b0 = data.readUInt8(off);
			const b1 = data.readUInt8(off + 1);
			const b2 = data.readUInt8(off + 2);
			let v = (b2 << 16) | (b1 << 8) | b0;
			if (v & 0x800000) v -= 0x1000000;
			samples[i] = v / 8388608;
		} else throw new WavError(`unsupported bit depth ${fmt.bits}`);
	}
	return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

/** Downmix to mono and resample (naive linear) to 16 kHz. */
export function toMono16k(wav: DecodedWav): Float32Array {
	const { samples, channels, sampleRate } = wav;
	const mono = new Float32Array(Math.floor(samples.length / channels));
	for (let f = 0; f < mono.length; f++) {
		let acc = 0;
		for (let c = 0; c < channels; c++) acc += samples[f * channels + c] ?? 0;
		mono[f] = acc / channels;
	}
	if (sampleRate === 16000) return mono;
	const ratio = 16000 / sampleRate;
	const out = new Float32Array(Math.floor(mono.length * ratio));
	for (let i = 0; i < out.length; i++) {
		const src = i / ratio;
		const i0 = Math.floor(src);
		const i1 = Math.min(i0 + 1, mono.length - 1);
		const frac = src - i0;
		const s0 = mono[i0] ?? 0;
		const s1 = mono[i1] ?? 0;
		out[i] = s0 * (1 - frac) + s1 * frac;
	}
	return out;
}

/** Encode mono Float32 PCM (-1..1) as a 16 kHz PCM16 WAV buffer (for tests/mocks). */
export function encodeWav16k(samples: Float32Array, sampleRate = 16000): Buffer {
	const data = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) {
		const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
		data.writeInt16LE(Math.round(v * 32767), i * 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}
