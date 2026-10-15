import type { ChatEntry } from "@pppi/protocol";
import { describe, expect, it } from "vitest";
import { artifactId, entryWithArtifacts, extractArtifacts, parseArtifactInfo } from "../src/artifacts.ts";

const FENCE = (title = 'title="Report"', body = "<p>hi</p>") =>
	`\`\`\`pppi-artifact ${title}\n${body}\n\`\`\``.replaceAll("`", "`");

describe("artifact fence extraction", () => {
	it("peels a supported artifact out of the text", () => {
		const src = `Here is the summary.\n\n${FENCE('title="Build report"', "<p>ok</p>")}\n\nAll done.`;
		const { text, artifacts } = extractArtifacts(src);
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]).toMatchObject({ title: "Build report", kind: "html", content: "<p>ok</p>" });
		expect(text).toBe("Here is the summary.\n\nAll done.");
	});

	it("ids are stable per (title, content) and change with content", () => {
		const a = extractArtifacts(FENCE('title="X"', "<p>one</p>")).artifacts[0]!;
		const b = extractArtifacts(FENCE('title="X"', "<p>one</p>")).artifacts[0]!;
		const c = extractArtifacts(FENCE('title="X"', "<p>two</p>")).artifacts[0]!;
		expect(a.id).toBe(b.id);
		expect(a.id).not.toBe(c.id);
		expect(a.id).toMatch(/^art-[0-9a-f]{12}$/);
		expect(a.id).toBe(artifactId("X", "<p>one</p>"));
	});

	it("parses quoted, single-quoted and bare titles; defaults when absent", () => {
		expect(parseArtifactInfo(' title="Build report"').title).toBe("Build report");
		expect(parseArtifactInfo(" title='Build report'").title).toBe("Build report");
		expect(parseArtifactInfo(" title=Report").title).toBe("Report");
		expect(parseArtifactInfo(" kind=html").title).toBe("Untitled artifact");
		expect(parseArtifactInfo("").kind).toBeNull();
		expect(parseArtifactInfo(" kind=html").kind).toBe("html");
	});

	it("kind defaults to html; unknown kinds stay as plain code (forward-compat)", () => {
		expect(extractArtifacts(FENCE("", "<p>x</p>")).artifacts[0]!.kind).toBe("html");
		const future = extractArtifacts(FENCE("kind=svg", "<svg/>"));
		expect(future.artifacts).toHaveLength(0);
		expect(future.text).toContain("pppi-artifact");
		expect(future.text).toContain("<svg/>");
	});

	it("multiple artifacts in one reply", () => {
		const src = `${FENCE('title="A"', "<p>a</p>")}\n\nmiddle\n\n${FENCE('title="B"', "<p>b</p>")}`;
		const { text, artifacts } = extractArtifacts(src);
		expect(artifacts.map((a) => a.title)).toEqual(["A", "B"]);
		expect(text).toBe("middle");
	});

	it("unclosed (mid-stream) and empty fences pass through untouched", () => {
		const mid = 'building:\n\n```pppi-artifact title="X"\n<p>partial';
		const r1 = extractArtifacts(mid);
		expect(r1.artifacts).toHaveLength(0);
		expect(r1.text).toBe(mid);
		const empty = extractArtifacts(FENCE('title="X"', "   "));
		expect(empty.artifacts).toHaveLength(0);
		expect(empty.text).toContain("pppi-artifact");
	});

	it("longer closing fences work (artifact content containing ``` lines)", () => {
		const src = '````pppi-artifact title="X"\ncontains\n```\ninner fence\n````\n';
		const { artifacts } = extractArtifacts(src);
		expect(artifacts[0]!.content).toBe("contains\n```\ninner fence");
	});

	it("text without fences returns unchanged", () => {
		const src = "plain **markdown** only\n\n```ts\nconst x = 1;\n```";
		expect(extractArtifacts(src)).toEqual({ text: src, artifacts: [] });
	});

	it("an artifact-only reply leaves clean empty text", () => {
		const { text, artifacts } = extractArtifacts(FENCE('title="X"', "<p>x</p>"));
		expect(artifacts).toHaveLength(1);
		expect(text).toBe("");
	});
});

describe("artifact entries", () => {
	const entry = (over: Partial<ChatEntry>): ChatEntry =>
		({ id: "m1", role: "assistant", text: "", ts: 0, ...over }) as ChatEntry;

	it("attaches artifacts and cleans the entry text", () => {
		const e = entryWithArtifacts(entry({ text: `Summary.\n\n${FENCE('title="R"', "<p>r</p>")}` }));
		expect(e.text).toBe("Summary.");
		expect(e.artifacts?.[0]?.title).toBe("R");
	});

	it("user entries and fence-free entries pass through untouched", () => {
		const user = entry({ role: "user", text: "```pppi-artifact" });
		expect(entryWithArtifacts(user)).toBe(user);
		const plain = entry({ text: "no fences here" });
		expect(entryWithArtifacts(plain)).toBe(plain);
	});
});
