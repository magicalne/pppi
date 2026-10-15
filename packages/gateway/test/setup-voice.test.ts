// setup-voice runtime step: verify (idempotent) that the sherpa-onnx-node
// addon piper loads through is installed, and that the script exits clean on
// the pure dry path (--no-stt --tts=none → no model downloads).

import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "scripts", "setup-voice.mjs");

describe("setup:voice runtime step", () => {
	it("verifies the sherpa runtime and exits clean (idempotent dry path)", async () => {
		const { stdout } = await run(process.execPath, [script, "--no-stt", "--tts=none"], { timeout: 60_000 });
		expect(stdout).toContain("sherpa-onnx-node");
		expect(stdout).toMatch(/✓ TTS runtime/);
		expect(stdout).not.toMatch(/↓|✗/); // nothing downloaded, nothing failed
	}, 90_000);

	it("skips the runtime step with --no-runtime", async () => {
		const { stdout } = await run(process.execPath, [script, "--no-stt", "--tts=none", "--no-runtime"], {
			timeout: 30_000,
		});
		expect(stdout).toContain("skipped (--no-runtime)");
	}, 60_000);
});
