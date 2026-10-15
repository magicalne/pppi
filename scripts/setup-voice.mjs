#!/usr/bin/env node
// setup-voice — make local voice work on this machine: models AND the piper
// runtime.
//
//   node scripts/setup-voice.mjs [--stt] [--no-stt] [--tts=piper|kokoro|none] [--all] [--no-runtime]
//
// Defaults: STT (parakeet GGUF) + piper TTS. `--all` takes STT + piper +
// kokoro. Models land under ~/.pppi/models/, which the gateway's resolvers
// pick up with zero env vars. The runtime step installs/verifies the
// sherpa-onnx-node addon piper loads through (bun install; npm fallback) —
// without it piper resolves its model but never speaks. Run ONCE per
// machine/checkout. Idempotent; interrupted downloads resume.
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
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const ttsFlag = argv.find((a) => a.startsWith("--tts="))?.slice(6);
// defaults: STT on, piper TTS; --all adds kokoro; --tts= picks one (or none)
const stt = !argv.includes("--no-stt");
const ttsSet = new Set(argv.includes("--all") ? ["piper", "kokoro"] : []);
if (!argv.includes("--all") && ttsFlag !== "none") ttsSet.add(ttsFlag ?? "piper");

const ROOT = join(homedir(), ".pppi", "models");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayRequire = createRequire(join(repoRoot, "packages", "gateway", "package.json"));
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

// ---- piper runtime: sherpa-onnx-node (optional native dep) ----------------
// Models alone are not enough: piper loads through the sherpa-onnx-node
// addon, and a checkout that never ran `bun install` (or where the optional
// install failed) resolves the model but cannot speak. Verify, install when
// missing, be loud about it either way. --no-runtime skips this step.
console.log(`pppi voice setup → models in ${ROOT}, runtime in ${repoRoot}\n`);
let failed = false;
if (argv.includes("--no-runtime")) {
	console.log("runtime: skipped (--no-runtime)\n");
} else if (!(await ensureSherpaRuntime())) {
	failed = true;
}

if (jobs.length === 0) {
	if (!argv.includes("--no-runtime")) {
		console.log(failed ? "\nsetup incomplete — see above.\n" : "\ndone — voice models/runtime checked.\n");
	}
	console.log("nothing selected — flags: --stt, --no-stt, --tts=piper|kokoro|none, --all, --no-runtime");
	process.exit(failed ? 1 : 0);
}

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

/** True when sherpa-onnx-node resolves from the gateway package (where bun links it). */
function sherpaInstalled() {
	try {
		gatewayRequire.resolve(join("sherpa-onnx-node", "package.json"));
		return true;
	} catch {
		return false;
	}
}

/** Install (bun install; npm fallback) or verify the piper runtime. Idempotent. */
async function ensureSherpaRuntime() {
	if (sherpaInstalled()) {
		console.log("  ✓ TTS runtime: sherpa-onnx-node present (piper can load)");
		return true;
	}
	console.log("  ↓ TTS runtime: sherpa-onnx-node missing — installing…");
	const run = (cmd, cwd = repoRoot) =>
		new Promise((r) => {
			const proc = spawn(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" });
			proc.on("exit", (code) => r(code === 0));
			proc.on("error", () => r(false));
		});
	// bun install pulls the optional dependency (+ the platform prebuild);
	// npm fallback for node-only machines (--no-save: no lockfile churn)
	const ok =
		(await run(["bun", "install"])) ||
		(await run(["npm", "install", "--no-save", "--prefix", "packages/gateway", "sherpa-onnx-node"]));
	if (ok && sherpaInstalled()) {
		console.log("  ✓ TTS runtime: sherpa-onnx-node installed");
		return true;
	}
	console.error("  ✗ TTS runtime still missing — piper TTS will NOT load.");
	console.error(`    fix: cd ${repoRoot} && bun install`);
	console.error("    (or: npm install --no-save --prefix packages/gateway sherpa-onnx-node)");
	return false;
}

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
	// the HF CDN routinely drops large downloads mid-stream; the .part file
	// resumes, so retry in-process before surfacing the failure
	let err;
	for (let attempt = 1; attempt <= 8; attempt++) {
		try {
			await attemptDownload(job);
			return;
		} catch (e) {
			err = e;
			// permanent client errors stop the loop; 408/429 are retryable
			// (timeout / rate limit — exactly when a CDN wants you back later)
			if (/^HTTP 4/.test(e.message) && !/^HTTP (408|429)/.test(e.message)) break;
			if (attempt < 8) {
				const asked = /retry-after=(\d+)/.exec(e.message); // honor 429 Retry-After
				const waitMs = asked ? Math.min(Number(asked[1]) * 1000, 60_000) : 1000 * attempt;
				await new Promise((r) => setTimeout(r, waitMs));
			}
		}
	}
	throw err;
}

async function attemptDownload(job) {
	const partial = `${job.dest}.part`;
	const startAt = existsSync(partial) ? statSync(partial).size : 0;
	// stall watchdog: the CDN sometimes leaves a connection open but sends
	// nothing — abort it so the retry loop can resume from the .part
	const abort = new AbortController();
	let lastByteAt = Date.now();
	const watchdog = setInterval(() => {
		if (Date.now() - lastByteAt > 90_000) abort.abort(new Error("download stalled (no bytes for 90s)"));
	}, 5000);
	// the watchdog must die on EVERY exit path: a fetch rejection, HTTP error,
	// or ignored range returns before the pipeline's finally — one live
	// interval per retry would keep the process running forever
	try {
		const res = await fetch(job.url, {
			...(startAt > 0 ? { headers: { range: `bytes=${startAt}-` } } : {}),
			signal: abort.signal,
		});
		if (!res.ok && res.status !== 206) {
			// 408 (timeout) and 429 (rate limit) are retryable — common during
			// large CDN downloads; surface Retry-After so the loop can honor it
			const retryAfter = Number(res.headers.get("retry-after") ?? "");
			throw new Error(
				retryAfter > 0 && Number.isFinite(retryAfter)
					? `HTTP ${res.status}; retry-after=${retryAfter}`
					: `HTTP ${res.status}`,
			);
		}
		const resumed = res.status === 206;
		if (startAt > 0 && !resumed) throw new Error("server ignored the resume range; delete the .part and retry");
		const total = (resumed ? startAt : 0) + Number(res.headers.get("content-length") ?? 0);
		let seen = resumed ? startAt : 0;
		lastByteAt = Date.now();
		const timer = setInterval(() => {
			const of = total ? ` / ${(total / 1e6).toFixed(0)} MB` : "";
			process.stdout.write(`\r  ↓ ${job.note}: ${(seen / 1e6).toFixed(1)} MB${of}   `);
		}, 1000);
		try {
			if (!res.body) throw new Error("empty response body");
			// pipeline (not manual write/drain waits): a disk-full or permission
			// error on the file stream must reject this job, never stall it or
			// escape as an unhandled `error` event. the counter is a Transform —
			// pipeline only accepts a Writable as the LAST stream, and a plain
			// Writable in the middle throws at call time.
			const counter = new Transform({
				transform(chunk, _enc, cb) {
					seen += chunk.byteLength;
					lastByteAt = Date.now();
					cb(null, chunk);
				},
			});
			await pipeline(res.body, counter, createWriteStream(partial, { flags: "a" }), { signal: abort.signal });
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
	} finally {
		clearInterval(watchdog);
	}
}
