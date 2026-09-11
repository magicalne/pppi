import { describe, expect, it } from "vitest";
import { streamSegments } from "../src/tts.ts";

describe("kokoro text-level streaming segments", () => {
	it("keeps the first segment short and later segments larger", () => {
		const text = "The build finished and all of the unit tests passed on the first attempt. Deployment should reach production soon.";
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
