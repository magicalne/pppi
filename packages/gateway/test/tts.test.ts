import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	EspeakNgProvider,
	MacosSayProvider,
	findExecutable,
	resolvePiperModel,
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
