// Unit tests for Stt's health/lifecycle semantics (mocked transcribe-cpp) and
// model resolution — no native model needed. The real-model behavior lives in
// stt.test.ts; these pin the state machine: status honesty after a failed
// load, the retry latch, batch tail-silence padding, and resolution hygiene.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Stt, resolveSttModel } from "../src/stt.ts";
import { voiceStt } from "../src/voice.ts";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	transcribed: [] as Float32Array[],
}));

vi.mock("transcribe-cpp", () => ({
	TranscribeModel: { load: mocks.load },
}));

const fakeModel = {
	transcribe: async (pcm: Float32Array) => {
		mocks.transcribed.push(pcm);
		return { text: "  mock transcript  " };
	},
	createSession: () => {
		throw new Error("no streaming in the fake");
	},
	capabilities: { supportsStreaming: false },
};

let fixtureFile: string;
let home: string;

function freshFixture(): void {
	home = mkdtempSync(join(tmpdir(), "pppi-stt-unit-"));
	fixtureFile = join(home, "model.gguf");
	writeFileSync(fixtureFile, "gguf-bytes");
}

afterEach(() => {
	vi.unstubAllEnvs();
	mocks.load.mockReset();
	mocks.transcribed.length = 0;
});

afterAll(() => {
	if (home) rmSync(home, { recursive: true, force: true });
});

describe("Stt load health", () => {
	it("flips status to not-ready when the model fails to load, and a retry recovers", async () => {
		freshFixture();
		vi.stubEnv("PPPI_STT_MODEL", fixtureFile);
		mocks.load.mockRejectedValueOnce(new Error("corrupt gguf"));

		const stt = Stt.create();
		expect(stt.status.ready).toBe(true); // resolution succeeded…
		const port = voiceStt(stt); // adapter built BEFORE the failure

		await expect(stt.warm()).rejects.toThrow(/corrupt gguf/);
		expect(stt.status.ready).toBe(false); // …but health now tells the load truth
		expect(stt.status).toMatchObject({ reason: expect.stringContaining("model failed to load: corrupt gguf") });
		// the adapter's status is LIVE — the ready line / voice_hello_ok see the flip
		expect(port.status.ready).toBe(false);

		// the failed load is not sticky: the next attempt loads again
		mocks.load.mockResolvedValueOnce(fakeModel as never);
		await stt.warm();
		expect(mocks.load).toHaveBeenCalledTimes(2);
		expect(stt.status.ready).toBe(true); // recovered
		expect(voiceStt(stt).status).toEqual({ ready: true, modelId: fixtureFile });
	});

	it("pads batch transcription with ~0.75s of trailing silence", async () => {
		freshFixture();
		vi.stubEnv("PPPI_STT_MODEL", fixtureFile);
		mocks.load.mockResolvedValue(fakeModel as never);
		const stt = Stt.create();

		const oneSecond = new Float32Array(16_000).fill(0.5); // speech-shaped enough
		const text = await stt.transcribe({ sampleRate: 16_000, channels: 1, samples: oneSecond });

		expect(text).toBe("mock transcript");
		const pcm = mocks.transcribed.at(-1);
		expect(pcm!.length).toBe(16_000 + 12_000); // 0.75s @ 16 kHz appended
		expect(pcm!.subarray(16_000).every((v) => v === 0)).toBe(true);
		// the original samples are untouched at the front
		expect(pcm!.subarray(0, 16_000).every((v) => v === 0.5)).toBe(true);
	});
});

describe("stt model resolution", () => {
	it("rejects directories and missing files as PPPI_STT_MODEL", () => {
		freshFixture();
		vi.stubEnv("PPPI_STT_MODEL", home); // a directory that EXISTS
		expect(resolveSttModel().ready).toBe(false);
		vi.stubEnv("PPPI_STT_MODEL", join(home, "nope.gguf"));
		expect(resolveSttModel().ready).toBe(false);
	});

	it("rejects an unreadable file as PPPI_STT_MODEL (a chmod-000 gguf is not a model)", () => {
		freshFixture();
		const unreadable = join(home, "locked.gguf");
		writeFileSync(unreadable, "x");
		chmodSync(unreadable, 0o000);
		vi.stubEnv("PPPI_STT_MODEL", unreadable);
		// pre-fix: statSync().isFile() passed and resolution claimed ready
		expect(resolveSttModel().ready).toBe(false);
	});

	it("prefers a parakeet .gguf in ~/.pppi/models/stt, skipping directories", () => {
		freshFixture();
		const sttDir = join(home, ".pppi", "models", "stt");
		mkdirSync(sttDir, { recursive: true });
		mkdirSync(join(sttDir, "000-a-directory.gguf")); // exists, is a dir — must not resolve
		writeFileSync(join(sttDir, "aaa-some-other.gguf"), "x");
		writeFileSync(join(sttDir, "zzz-parakeet-something.gguf"), "x");
		vi.stubEnv("HOME", home);
		vi.stubEnv("PPPI_STT_MODEL", "");

		const status = resolveSttModel();
		expect(status).toMatchObject({ ready: true, modelId: "zzz-parakeet-something.gguf" });
	});

	it("falls back to the sorted-first .gguf when no parakeet is present", () => {
		freshFixture();
		const sttDir = join(home, ".pppi", "models", "stt");
		mkdirSync(sttDir, { recursive: true });
		writeFileSync(join(sttDir, "m-model.gguf"), "x");
		writeFileSync(join(sttDir, "a-model.gguf"), "x");
		vi.stubEnv("HOME", home);
		vi.stubEnv("PPPI_STT_MODEL", "");

		expect(resolveSttModel()).toMatchObject({ ready: true, modelId: "a-model.gguf" });
	});
});
