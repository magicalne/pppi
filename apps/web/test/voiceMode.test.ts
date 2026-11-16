// Voice mode tests (#53): parsing/persistence decisions + the Android
// enum labels. The gateway-side semantics live in voice.test.ts (ptt frames).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseVoiceMode } from "../src/voice/voiceMode.ts";

describe("parseVoiceMode (#53)", () => {
	it("ptt stays ptt; everything else falls back to always (#54 flips the default to off)", () => {
		expect(parseVoiceMode("ptt")).toBe("ptt");
		expect(parseVoiceMode("always")).toBe("always");
		expect(parseVoiceMode(null)).toBe("always");
		expect(parseVoiceMode("junk")).toBe("always");
	});
});

describe("android VoiceMode (#53)", () => {
	it("labels + hints exist for all three modes", () => {
		const src = readFileSync(
			new URL("../../../apps/android/app/src/main/java/dev/pppi/omni/VoiceMode.kt", import.meta.url),
			"utf8",
		);
		for (const label of ["Always listen", "Push to talk", "Off"]) {
			expect(src).toContain(`"${label}"`);
		}
		expect(src).toContain("VoiceModeStore");
	});
});
