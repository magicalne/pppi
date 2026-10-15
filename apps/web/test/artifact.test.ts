import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact } from "@pppi/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ARTIFACT_CSP, ARTIFACT_SANDBOX, ArtifactCard, ArtifactView, artifactSrcdoc } from "../src/Artifact.tsx";
import { Markdown } from "../src/markdown.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const demoHtml = readFileSync(join(here, "../../../docs/fixtures/demo-artifact.html"), "utf8");

const demo: Artifact = {
	id: "art-demo",
	title: "Fleet status (demo)",
	kind: "html",
	content: demoHtml.trim(),
};

describe("artifact card", () => {
	it("renders a tappable card with title and kind", () => {
		const html = renderToStaticMarkup(createElement(ArtifactCard, { artifact: demo, onOpen: () => {} }));
		expect(html).toContain("artifact-card");
		expect(html).toContain(demo.title);
		expect(html).toContain("html view · tap to open");
		expect(html).toContain("<button");
	});

	it("future kinds render an explicit unsupported affordance (disabled)", () => {
		const future: Artifact = { ...demo, kind: "svg" as never };
		const html = renderToStaticMarkup(createElement(ArtifactCard, { artifact: future, onOpen: () => {} }));
		expect(html).toContain("unsupported");
		expect(html).toContain("not supported on this client yet");
		expect(html).toContain('disabled=""');
	});
});

describe("artifact sandbox (issue #17 security)", () => {
	it("iframe sandbox allows scripts but NEVER same-origin", () => {
		expect(ARTIFACT_SANDBOX).toBe("allow-scripts");
		expect(ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
		expect(ARTIFACT_SANDBOX).not.toContain("allow-forms");
		expect(ARTIFACT_SANDBOX).not.toContain("allow-popups");
		expect(ARTIFACT_SANDBOX).not.toContain("allow-top-navigation");
	});

	it("CSP blocks all network — inline-only, data: assets", () => {
		expect(ARTIFACT_CSP).toContain("default-src 'none'");
		expect(ARTIFACT_CSP).toContain("style-src 'unsafe-inline'");
		expect(ARTIFACT_CSP).toContain("script-src 'unsafe-inline'");
		expect(ARTIFACT_CSP).not.toContain("connect-src");
		expect(ARTIFACT_CSP).not.toMatch(/https?:/);
	});

	it("srcdoc injects the CSP as the very first thing", () => {
		const doc = artifactSrcdoc(demo);
		expect(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`)).toBe(
			true,
		);
		expect(doc).toContain(demo.content);
	});

	it("the full-screen view wires sandbox + no-referrer + CSP srcdoc", () => {
		const html = renderToStaticMarkup(createElement(ArtifactView, { artifact: demo, onClose: () => {} }));
		expect(html).toContain(`sandbox="${ARTIFACT_SANDBOX}"`);
		expect(html).toContain('referrerPolicy="no-referrer"');
		expect(html).toContain("&lt;meta http-equiv=&quot;Content-Security-Policy&quot;");
		expect(html).toContain(demo.title);
	});
});

describe("artifact envelope + streaming placeholder", () => {
	it("the wire envelope round-trips losslessly", () => {
		const wire = JSON.parse(JSON.stringify(demo)) as Artifact;
		expect(wire).toEqual(demo);
	});

	it("artifact fences arriving via deltas render a building card, not raw HTML", () => {
		const streaming = 'Here you go:\n\n```pppi-artifact title="Report"\n<p>partial content…';
		const html = renderToStaticMarkup(createElement(Markdown, { text: streaming }));
		expect(html).toContain("building artifact");
		expect(html).not.toContain("<p>partial content");
	});
});

describe("demo fixture (one-tap QA)", () => {
	it("is self-contained: no scripts, no external references", () => {
		expect(demo.content).not.toMatch(/<script/i);
		expect(demo.content).not.toMatch(/https?:\/\//);
		expect(demo.content).not.toMatch(/src="/i);
		expect(demo.content).toContain("<!doctype html>");
		expect(demo.content).toContain("Fleet status");
	});
});
