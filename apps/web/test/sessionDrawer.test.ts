// Sessions drawer coloring tests (#45) — dot colors from the profiles map
// (the same source reply attribution uses), fallback behavior, state
// modifiers, section-header tints, and a palette-vs-theme sanity pass.

import type { Profile, SessionsResponse } from "@pppi/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionDrawer } from "../src/SessionDrawer.tsx";
import { dotStateClass, sectionTint, sessionDotColor } from "../src/drawer.ts";

const profiles: Record<string, Profile> = {
	omni0: { id: "omni0", name: "omni", color: "#e8b14a", description: "" },
	main1: { id: "main1", name: "ppi-dev-1", color: "#5b8c51", description: "" },
	wt2: { id: "wt2", name: "", color: "#7aa2ff", description: "" },
	// no profile entry for "noprof"
};

const sessions: SessionsResponse = {
	omniSessionId: "omni0",
	projects: [
		{
			name: "pppi",
			path: "~/code/pppi",
			sessions: [
				{ sessionId: "main1", name: "ppi-dev-1", state: "busy", cwd: "~/code/pppi", branch: "main", worktree: null },
				{ sessionId: "wt2", name: null, state: "idle", cwd: "~/code/pppi/.worktrees/x", branch: "wt/x", worktree: "x" },
				{ sessionId: "noprof", name: null, state: "unreachable", cwd: "~/code/road", branch: "main", worktree: null },
			],
		},
	],
	others: [],
	profiles,
};

function render(target = { id: "", label: "omni" }): string {
	return renderToStaticMarkup(
		createElement(SessionDrawer, {
			sessions,
			profiles,
			target,
			onPick: () => {},
			onUnpair: () => {},
		}),
	);
}

describe("sessionDotColor (fallback + validation)", () => {
	it("uses the profile color when present", () => {
		expect(sessionDotColor({ color: "#5b8c51" })).toBe("#5b8c51");
	});
	it("falls back to '' (theme accent in CSS) without a profile or with junk", () => {
		expect(sessionDotColor(undefined)).toBe("");
		expect(sessionDotColor({})).toBe("");
		expect(sessionDotColor({ color: "javascript:alert(1)" })).toBe("");
		expect(sessionDotColor({ color: "#12345" })).toBe("");
	});
});

describe("dotStateClass", () => {
	it("busy pulses, busy+queued pulses, unreachable hollows, idle stays solid", () => {
		expect(dotStateClass("busy")).toBe("busy");
		expect(dotStateClass("busy+queued")).toBe("busy");
		expect(dotStateClass("unreachable")).toBe("unreach");
		expect(dotStateClass("idle")).toBe("");
	});
});

describe("sectionTint", () => {
	it("mixes the label toward the profile color and tints the rule", () => {
		const t = sectionTint("#5b8c51");
		expect(t.color).toBe("color-mix(in oklab, var(--text) 78%, #5b8c51)");
		expect(t.borderTopColor).toBe("#5b8c51");
	});
});

describe("SessionDrawer render (#45)", () => {
	it("drawer colors match reply attribution per session", () => {
		const html = render();
		// the omni row wears the omni profile color
		expect(html).toContain("background:#e8b14a");
		// session rows wear THEIR profile colors — main first
		expect(html.indexOf("background:#5b8c51")).toBeGreaterThan(-1);
		expect(html).toContain("background:#7aa2ff");
	});

	it("falls back to the CSS accent when a session has no profile", () => {
		const html = render();
		// the noprof row: ring with a state class but NO inline background
		const m = /<span class="ring unreach"><\/span>/.exec(html);
		expect(m).not.toBeNull();
	});

	it("state stays distinguishable: busy pulses, unreachable hollows, labels persist", () => {
		const html = render();
		expect(html).toContain('class="ring busy"');
		expect(html).toContain('class="ring unreach"');
		expect(html).toContain("working…");
		expect(html).toContain("unreachable");
		expect(html).toContain(">idle<");
	});

	it("section headers wear the repo's main-session color", () => {
		const html = render();
		expect(html).toContain("color-mix(in oklab, var(--text) 78%, #5b8c51)");
		expect(html).toContain("border-top-color:#5b8c51");
		expect(html).toContain('class="shead"');
	});

	it("unnamed sessions fall back to #id labels", () => {
		expect(render()).toContain(">#nopr</span>"); // unnamed session falls back to the #id prefix
	});
});

describe("palette sanity across themes", () => {
	it("rings carry the text-tinted keyline that guarantees shape on any bg", async () => {
		const css = (await import("node:fs")).readFileSync(new URL("../src/styles.css", import.meta.url).pathname, "utf8");
		expect(css).toMatch(
			/\.srow \.ring[\s\S]*?box-shadow: inset 0 0 0 1px color-mix\(in oklab, var\(--text\) 35%, transparent\)/,
		);
	});

	it("every profile palette color separates from every theme background", async () => {
		// the palette lives in @pppi/protocol (type-only from the web bundle);
		// tests read the source text so no runtime link is needed
		const proto = (await import("node:fs")).readFileSync(
			new URL("../../../packages/protocol/src/index.ts", import.meta.url).pathname,
			"utf8",
		);
		const block = /export const PROFILE_COLORS = \[(.*?)\]/s.exec(proto)?.[1] ?? "";
		const PROFILE_COLORS = [...block.matchAll(/"(#[0-9a-f]{6})"/g)].map((m) => m[1]!);
		expect(PROFILE_COLORS.length).toBeGreaterThanOrEqual(10);
		const css = (await import("node:fs")).readFileSync(new URL("../src/tokens.css", import.meta.url).pathname, "utf8");
		const bgs = [...css.matchAll(/--bg:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1]!);
		expect(bgs.length).toBeGreaterThanOrEqual(5);
		const lum = (hex: string) => {
			const h = hex.replace("#", "");
			const ch = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
			return (
				0.2126 * ch(Number.parseInt(h.slice(0, 2), 16) / 255) +
				0.7152 * ch(Number.parseInt(h.slice(2, 4), 16) / 255) +
				0.0722 * ch(Number.parseInt(h.slice(4, 6), 16) / 255)
			);
		};
		const contrast = (a: string, b: string) => {
			const la = lum(a);
			const lb = lum(b);
			return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
		};
		for (const color of PROFILE_COLORS) {
			for (const bg of bgs) {
				// the dot is an identity swatch with a guaranteed keyline
				// (inset --text mix, asserted below), not text: same-luminance
				// pairs like amber-on-dawn are legal; near-invisible is not
				expect(contrast(color, bg), `${color} on ${bg}`).toBeGreaterThanOrEqual(1.75);
			}
		}
	});
});
