import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	EspeakNgProvider,
	KokoroProvider,
	MacosSayProvider,
	SherpaPiperProvider,
	findExecutable,
	resolvePiperModel,
	resolveSherpaAddon,
	resolveTtsProvider,
	streamSegments,
} from "../src/tts.ts";

describe("kokoro text-level streaming segments", () => {
	it("keeps the first segment short and later segments larger", () => {
		const text =
			"The build finished and all of the unit tests passed on the first attempt. Deployment should reach production soon.";
		const segs = streamSegments(text);
		expect(segs.length).toBeGreaterThan(1);
		expect(segs[0]!.trim().split(/\s+/).length).toBeLessThanOrEqual(6); // fast first audio
		expect(segs.join(" ")).toBe(text); // nothing lost or reordered
	});

	it("splits long sentences at commas", () => {
		const text = "The build finished, the tests passed, and the deploy is green so we can move on to the next task.";
		const segs = streamSegments(text);
		expect(segs.length).toBeGreaterThanOrEqual(2);
		expect(segs.join(" ")).toBe(text);
		for (const seg of segs.slice(1)) {
			expect(seg.trim().split(/\s+/).length).toBeLessThanOrEqual(20);
		}
	});

	it("passes short text through as one segment", () => {
		expect(streamSegments("Hello there.")).toEqual(["Hello there."]);
	});
});

// ------------------------------------------------- provider resolution (linux port)

describe("tts provider resolution", () => {
	let emptyDir: string;
	let piperFixture: string;

	beforeAll(() => {
		emptyDir = mkdtempSync(join(tmpdir(), "pppi-tts-empty-"));
		piperFixture = mkdtempSync(join(tmpdir(), "pppi-tts-piper-"));
		mkdirSync(join(piperFixture, "vits-piper-x"), { recursive: true });
		mkdirSync(join(piperFixture, "vits-piper-x", "espeak-ng-data"), { recursive: true });
		writeFileSync(join(piperFixture, "vits-piper-x", "model.onnx"), "fake");
		writeFileSync(join(piperFixture, "vits-piper-x", "tokens.txt"), "fake");
	});

	afterAll(() => {
		rmSync(emptyDir, { recursive: true, force: true });
		rmSync(piperFixture, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("finds executables on PATH and misses elsewhere", () => {
		expect(findExecutable("definitely-not-a-real-binary-xyz")).toBeNull();
		// /bin/sh exists on every POSIX the repo targets
		expect(findExecutable("sh")).toMatch(/sh$/);
	});

	it("piper resolution accepts a complete vits dir and rejects incomplete ones", () => {
		const good = resolvePiperModel([join(piperFixture, "vits-piper-x")]);
		expect("reason" in good ? good.reason : good.onnx).toContain("model.onnx");
		const empty = resolvePiperModel([emptyDir]);
		expect("reason" in empty).toBe(true);
	});

	it("piper resolution treats file paths and missing paths as non-matches, not crashes", () => {
		// PPPI_TTS_MODEL can point anywhere — a stray file (e.g. a kokoro
		// .onnx) must not abort gateway boot with a readdir error
		const notADir = join(piperFixture, "vits-piper-x", "model.onnx");
		expect(existsSync(notADir)).toBe(true);
		const fileHit = resolvePiperModel([notADir, "/definitely/not/here"]);
		expect("reason" in fileHit).toBe(true);
		// and full auto resolution still completes through the fallback
		vi.stubEnv("HOME", emptyDir); // the real ~/.pppi must not leak in
		vi.stubEnv("PPPI_TTS_MODEL", notADir);
		vi.stubEnv("PPPI_TTS_PROVIDER", "");
		const provider = resolveTtsProvider({ piperDirs: undefined, kokoroDirs: [emptyDir] });
		expect(provider.id).not.toBe("piper");
	});

	it("auto picks piper when a model dir is present", () => {
		// HOME → empty tmp: the real ~/.pppi and HF cache can't leak in
		vi.stubEnv("HOME", emptyDir);
		vi.stubEnv("PPPI_TTS_MODEL", "");
		vi.stubEnv("PPPI_TTS_PROVIDER", "");
		const provider = resolveTtsProvider({ piperDirs: [join(piperFixture, "vits-piper-x")], kokoroDirs: [emptyDir] });
		expect(provider.id).toBe("piper");
		expect(provider.status.ready).toBe(true);
	});

	it("auto falls back to espeak-ng on linux when no model is present", () => {
		vi.stubEnv("HOME", emptyDir);
		vi.stubEnv("PPPI_TTS_MODEL", "");
		vi.stubEnv("PPPI_TTS_PROVIDER", "");
		const provider = resolveTtsProvider({ piperDirs: [emptyDir], kokoroDirs: [emptyDir] });
		if (process.platform === "darwin") {
			expect(provider.id).toBe("macos-say");
			return;
		}
		expect(provider.id).toBe("espeak-ng");
		if (findExecutable("espeak-ng")) expect(provider.status.ready).toBe(true);
		else expect(provider.status.ready).toBe(false); // honest, with an install hint
	});

	it("explicit macos-say off darwin reports not ready instead of failing at synth time", () => {
		vi.stubEnv("PPPI_TTS_PROVIDER", "macos-say");
		const provider = new MacosSayProvider();
		if (process.platform === "darwin") {
			expect(provider.status.ready).toBe(true);
		} else {
			expect(provider.status.ready).toBe(false);
			expect(provider.status).toHaveProperty("reason");
		}
	});

	it("explicit espeak-ng resolves to the espeak provider", () => {
		vi.stubEnv("PPPI_TTS_PROVIDER", "espeak-ng");
		expect(resolveTtsProvider().id).toBe("espeak-ng");
	});
});

const espeakBin = findExecutable("espeak-ng");

describe.skipIf(!espeakBin)("espeak-ng synthesis (real binary)", () => {
	it("speaks prose into PCM16 chunks at its native rate", async () => {
		const provider = new EspeakNgProvider();
		expect(provider.status.ready).toBe(true);
		let samples = 0;
		let rate = 0;
		for await (const chunk of provider.synthesize("The build is green and the tests passed.")) {
			samples += chunk.pcm.length / 2;
			rate = chunk.rate;
		}
		expect(rate).toBeGreaterThan(8000); // 22050 on stock espeak-ng
		expect(samples / rate).toBeGreaterThan(0.5); // real audio, not silence
	}, 30_000);

	it("honors an explicit voice override", async () => {
		const provider = new EspeakNgProvider("en-gb");
		expect((provider.status as { voice?: string }).voice).toBe("en-gb");
		for await (const _chunk of provider.synthesize("ok")) break; // one chunk proves synth works
	}, 30_000);
});

// --------------------------------------------------- engine health + abort seam

describe("tts engine health honesty", () => {
	let garbageDir: string;

	beforeAll(() => {
		// a complete-looking vits dir whose model is garbage: resolution
		// succeeds, the native engine load throws
		garbageDir = mkdtempSync(join(tmpdir(), "pppi-tts-garbage-"));
		mkdirSync(join(garbageDir, "espeak-ng-data"), { recursive: true });
		writeFileSync(join(garbageDir, "model.onnx"), "garbage");
		writeFileSync(join(garbageDir, "tokens.txt"), "garbage");
	});

	afterAll(() => {
		rmSync(garbageDir, { recursive: true, force: true });
	});

	it("piper: a resolved-but-unloadable model flips status and does not cache the failure", async () => {
		const provider = new SherpaPiperProvider([garbageDir]);
		expect(provider.status.ready).toBe(true); // resolution is fine…

		await expect(provider.warm()).rejects.toThrow();
		expect(provider.status.ready).toBe(false); // …but health reports the LOAD
		expect(provider.status).toMatchObject({ reason: expect.stringContaining("failed") });

		// the failed load is not sticky — a later attempt retries (and reports
		// the fresh failure again rather than a cached verdict)
		await expect(provider.warm()).rejects.toThrow();
		expect(provider.status.ready).toBe(false);
	}, 30_000);

	it("synthesis of an unresolved provider still throws the resolution reason", async () => {
		const provider = new SherpaPiperProvider(["/definitely/not/here"]);
		expect(provider.status.ready).toBe(false);
		await expect(async () => {
			for await (const _chunk of provider.synthesize("hello")) break;
		}).rejects.toThrow(/piper needs|no complete/);
	});
});

describe.skipIf(!espeakBin)("espeak-ng abort (real binary)", () => {
	it("kills the espeak-ng child when the signal fires — no orphan, prompt AbortError", async () => {
		const provider = new EspeakNgProvider();
		// minutes of audio if left alone: the whole point is that abort does not wait
		const longText = "this sentence keeps going and going. ".repeat(1500);
		const ac = new AbortController();
		const iter = provider.synthesize(longText, ac.signal)[Symbol.asyncIterator]();
		const started = Date.now();

		const first = iter.next(); // spawns espeak-ng
		await new Promise((r) => setTimeout(r, 100)); // let it get going
		ac.abort();

		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(Date.now() - started).toBeLessThan(5_000); // minutes of synthesis, cut in seconds

		// no orphaned espeak-ng process keeps synthesizing in the background —
		// scoped to THIS worker's direct children so an unrelated espeak-ng
		// (another test worker, a user process) can't fail the assertion
		await new Promise((r) => setTimeout(r, 300));
		let orphan = false;
		try {
			execFileSync("pgrep", ["-P", String(process.pid), "espeak-ng"]);
			orphan = true;
		} catch {
			// pgrep exits 1 when nothing matches — that is the good case
		}
		expect(orphan).toBe(false);
	}, 30_000);
});

describe("invalid PPPI_TTS_PROVIDER", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("warns and falls back to auto instead of silently meaning auto", () => {
		const home = mkdtempSync(join(tmpdir(), "pppi-tts-invalid-"));
		try {
			vi.stubEnv("HOME", home); // isolate from the real ~/.pppi and HF cache
			vi.stubEnv("PPPI_TTS_MODEL", "");
			vi.stubEnv("PPPI_TTS_PROVIDER", "kokoro-typo"); // not a known provider
			const err = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const provider = resolveTtsProvider({ piperDirs: [], kokoroDirs: [] });
				// auto semantics: platform fallback, NOT the typo silently kept as auto
				expect(["macos-say", "espeak-ng"]).toContain(provider.id);
				expect(err).toHaveBeenCalledTimes(1);
				expect(err.mock.calls[0]?.[0]).toContain("kokoro-typo");
				// warn once: a second resolution stays quiet
				resolveTtsProvider({ piperDirs: [], kokoroDirs: [] });
				expect(err).toHaveBeenCalledTimes(1);
			} finally {
				err.mockRestore();
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

// --------------------------------------------------- sherpa runtime resolution + loud failures

/** A fake sherpa-onnx-node package under <root>/node_modules (resolution only — never loads). */
function fakeSherpaPackage(root: string): void {
	const dir = join(root, "node_modules", "sherpa-onnx-node");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "sherpa-onnx-node", version: "0.0.0-test", main: "index.js" }),
	);
	writeFileSync(join(dir, "index.js"), "module.exports = { OfflineTts: class OfflineTts {} };");
}

describe("sherpa runtime resolution (piper)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("resolves the addon from a base next to the package", () => {
		const root = mkdtempSync(join(tmpdir(), "pppi-sherpa-base-"));
		fakeSherpaPackage(root);
		const addon = resolveSherpaAddon({ bases: [join(root, "probe.js")], repoRoots: [] });
		expect(addon).not.toBeNull();
		expect(typeof addon!.OfflineTts).toBe("function");
		rmSync(root, { recursive: true, force: true });
	});

	it("falls back to the repo checkout an extension was stamped from", () => {
		const repo = mkdtempSync(join(tmpdir(), "pppi-sherpa-repo-"));
		fakeSherpaPackage(join(repo, "packages", "gateway"));
		writeFileSync(join(repo, "packages", "gateway", "package.json"), JSON.stringify({ name: "@pppi/gateway" }));
		// bases miss; the gateway package's node_modules is the fallback leg
		const miss = mkdtempSync(join(tmpdir(), "pppi-sherpa-miss-"));
		const addon = resolveSherpaAddon({ bases: [join(miss, "probe.js")], repoRoots: [repo] });
		expect(addon).not.toBeNull();
		rmSync(repo, { recursive: true, force: true });
		rmSync(miss, { recursive: true, force: true });
	});

	it("returns null when the runtime is nowhere", () => {
		const miss = mkdtempSync(join(tmpdir(), "pppi-sherpa-none-"));
		expect(resolveSherpaAddon({ bases: [join(miss, "probe.js")], repoRoots: [miss] })).toBeNull();
		rmSync(miss, { recursive: true, force: true });
	});
});

describe("tts failure loudness (audio.log)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("logs why auto skipped piper and kokoro", () => {
		const dir = mkdtempSync(join(tmpdir(), "pppi-tts-loud-"));
		// HOME → empty: no models; PPPI_DIR → tmp: capture the diary
		vi.stubEnv("HOME", dir);
		vi.stubEnv("PPPI_DIR", dir);
		vi.stubEnv("PPPI_TTS_MODEL", "");
		vi.stubEnv("PPPI_TTS_PROVIDER", "");
		resolveTtsProvider({ piperDirs: [], kokoroDirs: [] });
		const log = readFileSync(join(dir, "logs", "audio.log"), "utf8");
		expect(log).toMatch(/tts: piper skipped — /);
		expect(log).toMatch(/tts: kokoro skipped — /);
		rmSync(dir, { recursive: true, force: true });
	});

	it("kokoro: a load failure flips status, retries (no sticky cache), and lands in audio.log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pppi-tts-kokoro-loud-"));
		// a complete-looking kokoro dir whose model is garbage: resolution
		// succeeds, the engine load throws (offline env: no network rescue)
		mkdirSync(join(dir, "onnx"), { recursive: true });
		writeFileSync(join(dir, "onnx", "model_quantized.onnx"), "garbage");
		vi.stubEnv("PPPI_DIR", dir);
		vi.stubEnv("HF_HUB_OFFLINE", "1");
		vi.stubEnv("TRANSFORMERS_OFFLINE", "1");
		const provider = new KokoroProvider([dir]);
		expect(provider.status.ready).toBe(true); // resolution is fine…

		await expect(provider.warm()).rejects.toThrow();
		expect(provider.status.ready).toBe(false); // …but health reports the LOAD
		expect(provider.status).toMatchObject({ reason: expect.stringContaining("failed") });
		// not sticky: the retry reports a fresh failure, not a cached verdict
		await expect(provider.warm()).rejects.toThrow();
		expect(provider.status.ready).toBe(false);
		const log = readFileSync(join(dir, "logs", "audio.log"), "utf8");
		expect(log).toMatch(/tts: kokoro load failed — /);
		rmSync(dir, { recursive: true, force: true });
	}, 60_000);
});

describe("auto engine selection", () => {
	let piperFixture: string;
	let kokoroFixture: string;
	let emptyDir: string;

	beforeAll(() => {
		emptyDir = mkdtempSync(join(tmpdir(), "pppi-tts-sel-empty-"));
		piperFixture = mkdtempSync(join(tmpdir(), "pppi-tts-sel-piper-"));
		const vits = join(piperFixture, "vits-piper-x");
		mkdirSync(join(vits, "espeak-ng-data"), { recursive: true });
		writeFileSync(join(vits, "model.onnx"), "fake");
		writeFileSync(join(vits, "tokens.txt"), "fake");
		kokoroFixture = mkdtempSync(join(tmpdir(), "pppi-tts-sel-kokoro-"));
		mkdirSync(join(kokoroFixture, "onnx"), { recursive: true });
		writeFileSync(join(kokoroFixture, "onnx", "model_quantized.onnx"), "fake");
	});

	afterAll(() => {
		for (const d of [emptyDir, piperFixture, kokoroFixture]) rmSync(d, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("prefers piper when both models are present (faster CPU default)", () => {
		vi.stubEnv("PPPI_TTS_PROVIDER", "");
		vi.stubEnv("PPPI_TTS_MODEL", "");
		const provider = resolveTtsProvider({
			piperDirs: [join(piperFixture, "vits-piper-x")],
			kokoroDirs: [kokoroFixture],
		});
		expect(provider.id).toBe("piper");
	});

	it("auto falls to kokoro when piper's model is absent", () => {
		vi.stubEnv("PPPI_TTS_PROVIDER", "");
		vi.stubEnv("PPPI_TTS_MODEL", "");
		const provider = resolveTtsProvider({ piperDirs: [emptyDir], kokoroDirs: [kokoroFixture] });
		expect(provider.id).toBe("kokoro");
	});

	it("explicit kokoro wins even when a piper model is present", () => {
		vi.stubEnv("PPPI_TTS_PROVIDER", "kokoro");
		const provider = resolveTtsProvider({
			piperDirs: [join(piperFixture, "vits-piper-x")],
			kokoroDirs: [kokoroFixture],
		});
		expect(provider.id).toBe("kokoro");
	});
});
