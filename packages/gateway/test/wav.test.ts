import { describe, expect, it } from "vitest";
import { WavError, decodeWav, encodeWav16k, toMono16k } from "../src/wav.ts";

describe("wav", () => {
	it("round-trips 16k mono PCM16", () => {
		const samples = new Float32Array(1600);
		for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 10) * 0.5;
		const buf = encodeWav16k(samples);
		const decoded = decodeWav(buf);
		expect(decoded.sampleRate).toBe(16000);
		expect(decoded.channels).toBe(1);
		expect(decoded.samples.length).toBe(samples.length);
		expect(decoded.samples[100]).toBeCloseTo(samples[100]!, 4);
	});

	it("monoizes stereo and resamples to 16k", () => {
		// 32 kHz stereo: left=+0.5, right=-0.5 → silence after downmix
		const frames = 320;
		const buf = Buffer.alloc(44 + frames * 2 * 2);
		buf.write("RIFF", 0, "ascii");
		buf.write("WAVE", 8, "ascii");
		buf.write("fmt ", 12, "ascii");
		buf.writeUInt32LE(16, 16);
		buf.writeUInt16LE(1, 20);
		buf.writeUInt16LE(2, 22);
		buf.writeUInt32LE(32000, 24);
		buf.writeUInt32LE(32000 * 4, 28);
		buf.writeUInt16LE(4, 32);
		buf.writeUInt16LE(16, 34);
		buf.write("data", 36, "ascii");
		buf.writeUInt32LE(frames * 2 * 2, 40);
		for (let f = 0; f < frames; f++) {
			buf.writeInt16LE(Math.round(0.5 * 32767), 44 + f * 4);
			buf.writeInt16LE(Math.round(-0.5 * 32767), 44 + f * 4 + 2);
		}
		const decoded = decodeWav(buf);
		const mono = toMono16k(decoded);
		expect(mono.length).toBe(160);
		// int16 quantization leaves ~half-LSB residue (2^-16); nothing audible
		for (const v of mono) expect(Math.abs(v)).toBeLessThan(1e-4);
	});

	it("rejects non-WAV input", () => {
		expect(() => decodeWav(Buffer.from("hello world, definitely not a wav file"))).toThrow(WavError);
		expect(() => decodeWav(Buffer.alloc(10))).toThrow(WavError);
	});

	it("rejects unsupported encodings (e.g. MP3-in-WAV / ADPCM)", () => {
		const buf = Buffer.alloc(44);
		buf.write("RIFF", 0, "ascii");
		buf.write("WAVE", 8, "ascii");
		buf.write("fmt ", 12, "ascii");
		buf.writeUInt32LE(16, 16);
		buf.writeUInt16LE(6, 20); // a-law
		buf.writeUInt16LE(1, 22);
		buf.writeUInt32LE(16000, 24);
		buf.writeUInt32LE(32000, 28);
		buf.writeUInt16LE(2, 32);
		buf.writeUInt16LE(8, 34);
		buf.write("data", 36, "ascii");
		buf.writeUInt32LE(0, 40);
		expect(() => decodeWav(buf)).toThrow(/unsupported WAV encoding/);
	});
});
