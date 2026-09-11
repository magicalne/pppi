// Latency benchmark for the live-voice stack on THIS machine. Not part of the
// test suite — run directly:
//   bun packages/gateway/test/bench-voice.ts
//
// What "good for live chatting" means here, per stage:
//   STT streaming  — each feed() of a 100ms chunk must return well under
//                    100ms wall (else the decoder can't keep up with the mic
//                    and lag accumulates as the user keeps speaking);
//                    time-to-first-partial gates how quickly the UI shows text
//   STT finalize   — the extra wait after endpointing before dispatch
//   STT batch      — realtime factor of one-shot transcribe (fallback path)
//   TTS            — time-to-first-chunk gates how fast the agent's voice
//                    starts; RTF < 1 means synthesis outruns playback

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stt, resolveSttModel } from "../src/stt.ts";
import { resolveTtsProvider } from "../src/tts.ts";
import type { TtsChunk } from "../src/tts.ts";

const PARAGRAPH =
	"The build finished about ten minutes ago and everything looks healthy so far. " +
	"The unit tests all passed on the first attempt, which honestly does not happen very often. " +
	"Deployment is currently in progress and should reach production within the next few minutes, " +
	"so let me know if you want me to keep watching the pipeline or move on to something else.";

const fmt = (ms: number): string => `${ms.toFixed(0)}ms`;
const stats = (xs: number[]): string => {
	if (!xs.length) return "n/a";
	const sorted = [...xs].sort((a, b) => a - b);
	const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	return `p50 ${fmt(p(0.5))} / p95 ${fmt(p(0.95))} / max ${fmt(sorted[sorted.length - 1]!)} / mean ${fmt(mean)}`;
};

/** `say` a phrase to 16k mono PCM16 in a temp dir. */
function speakToPcm(phrase: string, dir: string, name: string): Float32Array {
	const wavPath = join(dir, `${name}.wav`);
	execFileSync("say", ["-o", wavPath, "--data-format=LEI16@16000", phrase]);
	const raw = readFileSync(wavPath).subarray(44); // PCM16 header off
	const pcm = new Float32Array(raw.length / 2);
	for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readInt16LE(i * 2) / 32768;
	return pcm;
}

async function benchSttStreaming(dir: string): Promise<void> {
	const model = resolveSttModel();
	if (!model.ready) {
		console.log(`\n[stt-stream] SKIPPED — ${model.reason}`);
		return;
	}
	console.log(`\n[stt-stream] model: ${model.modelId}`);

	const stt = Stt.create();
	const t0 = performance.now();
	await stt.warm();
	console.log(`  model load (cold):        ${fmt(performance.now() - t0)}`);

	const pcm = speakToPcm(PARAGRAPH, dir, "stt");
	const seconds = pcm.length / 16000;
	console.log(`  audio:                    ${seconds.toFixed(1)}s`);

	// live mic simulation: 100ms chunks at realtime pace
	const utt = await stt.openUtterance();
	if (!utt) {
		console.log("  SKIPPED — model has no streaming mode");
		return;
	}
	const chunk = 1600; // 100ms @ 16k
	const feedMs: number[] = [];
	let firstPartialMs: number | null = null;
	let fedAudioMs = 0;
	const start = performance.now();
	for (let off = 0; off < pcm.length; off += chunk) {
		const piece = pcm.subarray(off, Math.min(off + chunk, pcm.length));
		const f0 = performance.now();
		const { committed, tentative } = await utt.feed(piece);
		feedMs.push(performance.now() - f0);
		fedAudioMs += (piece.length / 16000) * 1000;
		if (firstPartialMs === null && (committed || tentative)) {
			firstPartialMs = fedAudioMs;
			console.log(`  first partial at:         ${fmt(firstPartialMs)} of spoken audio`);
		}
		// pace at realtime: sleep the remainder of the 100ms budget
		const spent = performance.now() - f0;
		if (spent < 100) await new Promise((r) => setTimeout(r, 100 - spent));
	}
	const decodeMs = feedMs.reduce((a, b) => a + b, 0);
	console.log(`  feed() wall per 100ms chunk: ${stats(feedMs)}`);
	console.log(`  decode RTF:               ${(decodeMs / 1000 / seconds).toFixed(3)}x realtime`);
	if (firstPartialMs === null) console.log("  first partial:            never (all silence to the decoder?)");
	const f0 = performance.now();
	const final = await utt.finalize();
	console.log(`  finalize() after end:     ${fmt(performance.now() - f0)}`);
	console.log(`  transcript:               ${JSON.stringify(final.slice(0, 90))}${final.length > 90 ? "…" : ""}`);
	utt.dispose();
	await stt.dispose();
}

async function benchSttBatch(dir: string): Promise<void> {
	const model = resolveSttModel();
	if (!model.ready) return;
	const stt = Stt.create();
	await stt.warm();
	const pcm = speakToPcm(PARAGRAPH, dir, "stt");
	const seconds = pcm.length / 16000;
	const runs: number[] = [];
	let text = "";
	for (let i = 0; i < 3; i++) {
		const t0 = performance.now();
		text = await stt.transcribe({ samples: pcm, sampleRate: 16000, channels: 1 } as never);
		runs.push(performance.now() - t0);
	}
	console.log(`\n[stt-batch] ${seconds.toFixed(1)}s of audio, 3 runs: ${runs.map(fmt).join(" / ")}`);
	console.log(`  RTF (best):               ${(Math.min(...runs) / 1000 / seconds).toFixed(3)}x realtime`);
	console.log(`  transcript:               ${JSON.stringify(text.slice(0, 90))}${text.length > 90 ? "…" : ""}`);
	await stt.dispose();
}

async function benchTts(id: "kokoro" | "macos-say"): Promise<void> {
	const save = process.env.PPPI_TTS_PROVIDER;
	process.env.PPPI_TTS_PROVIDER = id;
	const provider = resolveTtsProvider();
	process.env.PPPI_TTS_PROVIDER = save;
	if (!provider.status.ready) {
		console.log(`\n[tts:${id}] SKIPPED — ${provider.status.reason}`);
		return;
	}
	console.log(`\n[tts:${id}] voice: ${provider.status.voice ?? "?"}`);
	const t0 = performance.now();
	await provider.warm();
	console.log(`  engine load (cold):       ${fmt(performance.now() - t0)}`);

	const sentence = "The build finished and all of the unit tests passed on the first attempt.";
	for (let i = 0; i < 3; i++) {
		const t1 = performance.now();
		let firstChunkMs: number | null = null;
		let totalMs = 0;
		let audioMs = 0;
		for await (const c of provider.synthesize(sentence) as AsyncIterable<TtsChunk>) {
			if (firstChunkMs === null) {
				firstChunkMs = performance.now() - t1;
				totalMs = firstChunkMs; // chunks after the first are pure slicing
			}
			audioMs += (c.pcm.length / 2 / c.rate) * 1000;
			if (i === 0 && totalMs === firstChunkMs) break; // first run: first-chunk latency only
		}
		console.log(
			`  run ${i + 1}: first audio after ${fmt(firstChunkMs ?? 0)}, audio ${audioMs.toFixed(0)}ms → RTF ${firstChunkMs && audioMs ? (firstChunkMs / audioMs).toFixed(3) : "?"}x`,
		);
	}
}

const dir = mkdtempSync(join(tmpdir(), "pppi-bench-"));
try {
	console.log("pppi voice benchmark — live-chat fitness on this machine");
	await benchSttStreaming(dir);
	await benchSttBatch(dir);
	await benchTts("piper");
	await benchTts("kokoro");
	await benchTts("macos-say");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
