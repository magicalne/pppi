#!/usr/bin/env node
// setup-voice — download the local voice models pppi's inference layer needs.
//
//   node scripts/setup-voice.mjs [--stt] [--no-stt] [--tts=piper|kokoro|none] [--all]
//
// Defaults: STT (parakeet GGUF) + piper TTS. `--all` takes STT + piper +
// kokoro. Models land under ~/.pppi/models/, which the gateway's resolvers
// pick up with zero env vars. Idempotent; interrupted downloads resume.
//
//   STT    ~/.pppi/models/stt/parakeet-unified-en-0.6b-Q8_0.gguf   (~660 MB)
//          the model pi-transcribe recommends (transcribe.cpp GGUF)
//   piper  ~/.pppi/models/tts/vits-piper-en_US-amy-medium/          (~63 MB)
//          fast neural voice via sherpa-onnx — the solid CPU default
//   kokoro ~/.pppi/models/tts/Kokoro-82M-v1.0-ONNX/                (~110 MB)
//          higher quality, slower on CPU; opt in with --tts=kokoro / --all
//
// Linux also wants the always-available fallback voice: `sudo apt install
// espeak-ng` (macOS: `brew install espeak`; the Mac fallback is `say`).

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const argv = process.argv.slice(2);
const ttsFlag = argv.find((a) => a.startsWith("--tts="))?.slice(6);
// defaults: STT on, piper TTS; --all adds kokoro; --tts= picks one (or none)
const stt = !argv.includes("--no-stt");
const ttsSet = new Set(argv.includes("--all") ? ["piper", "kokoro"] : []);
if (!argv.includes("--all") && ttsFlag !== "none") ttsSet.add(ttsFlag ?? "piper");

const ROOT = join(homedir(), ".pppi", "models");
const jobs = [];

if (stt) {
	jobs.push({
		url: "https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/main/parakeet-unified-en-0.6b-Q8_0.gguf",
		dest: join(ROOT, "stt", "parakeet-unified-en-0.6b-Q8_0.gguf"),
		minBytes: 500 * 1024 * 1024,
		note: "STT: parakeet-unified-en-0.6b Q8_0 (transcribe.cpp GGUF)",
	});
}
if (ttsSet.has("piper")) {
	jobs.push({
		url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-medium.tar.bz2",
		dest: join(ROOT, "tts", "vits-piper-en_US-amy-medium.tar.bz2"),
		extractInto: join(ROOT, "tts"),
		payload: "vits-piper-en_US-amy-medium",
		minBytes: 50 * 1024 * 1024,
		note: "TTS: piper en_US-amy-medium (sherpa-onnx vits)",
	});
}
if (ttsSet.has("kokoro")) {
	const dir = join(ROOT, "tts", "Kokoro-82M-v1.0-ONNX");
	const base = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";
	// absolute byte floors — config.json really is ~44 bytes; kokoro-js also
	// needs the tokenizer files at runtime (phonemizer loads tokenizer.json)
	for (const [rel, minBytes] of [
		["config.json", 16],
		["tokenizer.json", 1024],
		["tokenizer_config.json", 16],
		["onnx/model_quantized.onnx", 80 * 1024 * 1024],
		["voices/af_heart.bin", 200 * 1024],
	]) {
		jobs.push({
			url: `${base}/${rel}`,
			dest: join(dir, rel),
			minBytes,
			note: `TTS: kokoro-82M q8 (${rel})`,
		});
	}
}

if (jobs.length === 0) {
	console.log("nothing selected — flags: --stt, --no-stt, --tts=piper|kokoro|none, --all");
	process.exit(0);
}

console.log(`pppi voice models → ${ROOT}\n`);
let failed = false;
for (const job of jobs) {
	try {
		await download(job);
	} catch (err) {
		failed = true;
		console.error(`\n  ✗ ${job.note}: ${err.message}`);
	}
}

for (const job of jobs) {
	if (!job.extractInto || !existsSync(job.dest) || existsSync(join(job.extractInto, job.payload))) continue;
	console.log(`  extracting ${job.payload}…`);
	await new Promise((resolve, reject) => {
		const proc = spawn("tar", ["xjf", job.dest, "-C", job.extractInto], { stdio: "inherit" });
		proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
		proc.on("error", reject);
	});
}

console.log(
	failed
		? "\nsome downloads failed — re-run; partial files resume automatically.\n"
		: "\ndone. boot the gateway (or /pppi_gateway) and talk — models load eagerly at startup.\n",
);
process.exit(failed ? 1 : 0);

async function download(job) {
	// extracted payloads count as done even without the tarball
	if (job.payload && existsSync(join(job.extractInto, job.payload))) {
		console.log(`  ✓ ${job.note} (already present)`);
		return;
	}
	mkdirSync(dirname(job.dest), { recursive: true });
	if (existsSync(job.dest) && statSync(job.dest).size >= job.minBytes) {
		console.log(`  ✓ ${job.note} (already present)`);
		return;
	}
	const partial = `${job.dest}.part`;
	const startAt = existsSync(partial) ? statSync(partial).size : 0;
	const res = await fetch(job.url, startAt > 0 ? { headers: { range: `bytes=${startAt}-` } } : {});
	if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
	const resumed = res.status === 206;
	if (startAt > 0 && !resumed) throw new Error("server ignored the resume range; delete the .part and retry");
	const total = (resumed ? startAt : 0) + Number(res.headers.get("content-length") ?? 0);
	let seen = resumed ? startAt : 0;
	const timer = setInterval(() => {
		const of = total ? ` / ${(total / 1e6).toFixed(0)} MB` : "";
		process.stdout.write(`\r  ↓ ${job.note}: ${(seen / 1e6).toFixed(1)} MB${of}   `);
	}, 1000);
	try {
		if (!res.body) throw new Error("empty response body");
		// pipeline (not manual write/drain waits): a disk-full or permission
		// error on the file stream must reject this job, never stall it or
		// escape as an unhandled `error` event
		const counter = new Writable({
			write(chunk, _enc, cb) {
				seen += chunk.byteLength;
				cb();
			},
		});
		await pipeline(res.body, counter, createWriteStream(partial, { flags: resumed ? "a" : "w" }));
	} finally {
		clearInterval(timer);
	}
	const size = statSync(partial).size;
	if (size < job.minBytes) {
		unlinkSync(partial);
		throw new Error(`download too small (${size} bytes) — deleted, retry`);
	}
	renameSync(partial, job.dest);
	process.stdout.write(`\r  ✓ ${job.note} (${(size / 1e6).toFixed(1)} MB)            \n`);
}
