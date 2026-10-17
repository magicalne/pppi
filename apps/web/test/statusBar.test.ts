// Brain-button tests (#48) — the brain's decisions live in pure functions:
// when it's dead (and why), and what a tap cycles to; plus alignment style
// assertions for the centered status-bar strip and the render shapes.

import { readFileSync } from "node:fs";
import type { AgentStatus, ModelInfo } from "@pppi/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBar } from "../src/status/StatusBar.tsx";
import { LADDER, brainDead, disabledReason, nextTapLevel } from "../src/status/brainState.ts";

function model(over: Partial<ModelInfo>): ModelInfo {
	return {
		provider: "mock",
		id: "m",
		name: "Mock",
		reasoning: false,
		contextWindow: 100_000,
		thinkingLevelMap: {},
		...over,
	};
}

function status(over: Partial<AgentStatus> = {}): AgentStatus {
	return {
		state: "idle",
		model: model({ reasoning: true, thinkingLevelMap: { off: "none", low: "low", high: "high" } }),
		thinkingLevel: "low",
		thinkingLevels: ["off", "low", "high"],
		...over,
	} as AgentStatus;
}

describe("brainDead (#48: map-aware detection)", () => {
	it("no model → dead", () => {
		expect(brainDead(null, [])).toBe(true);
	});
	it("reasoning flag keeps it alive", () => {
		expect(brainDead(model({ reasoning: true }), [])).toBe(false);
	});
	it("multi-stop levels keep it alive without the flag", () => {
		expect(brainDead(model({ reasoning: false }), ["off", "low"])).toBe(false);
	});
	it("the bug shape: flag missing + RPC answers off-only, but the map carries truth → ALIVE", () => {
		expect(
			brainDead(model({ reasoning: false, thinkingLevelMap: { off: "none", low: "low", medium: "medium" } }), ["off"]),
		).toBe(false);
	});
	it("truly non-thinking models stay dead", () => {
		expect(brainDead(model({ reasoning: false, thinkingLevelMap: {} }), ["off"])).toBe(true);
	});
});

describe("disabledReason (never a silent dead icon)", () => {
	it("names the model that doesn't do thinking", () => {
		expect(disabledReason(model({ name: "glm-5.3" }), true, "road")).toBe("glm-5.3 doesn't do thinking");
	});
	it("no model yet", () => {
		expect(disabledReason(null, true, "road")).toBe("no model yet");
	});
	it("peer target explains where to switch", () => {
		expect(disabledReason(model({ name: "x" }), false, "road")).toBe("switch model in road itself");
	});
});

describe("nextTapLevel (tap cycles, #48)", () => {
	const stops = ["off", "low", "high"];
	it("cycles forward and wraps max → off", () => {
		expect(nextTapLevel(stops, "off")).toBe("low");
		expect(nextTapLevel(stops, "low")).toBe("high");
		expect(nextTapLevel(stops, "high")).toBe("off");
	});
	it("single stop → null (nothing to cycle)", () => {
		expect(nextTapLevel(["off"], "off")).toBeNull();
	});
	it("unknown level → first stop", () => {
		expect(nextTapLevel(stops, "weird")).toBe("off");
	});
	it("the ladder is in canonical pi order", () => {
		expect(LADDER.slice(0, 3)).toEqual(["off", "minimal", "low"]);
	});
});

describe("StatusBar render", () => {
	const base = {
		models: [] as ModelInfo[],
		active: true,
		targetLabel: "road",
		send: () => {},
		notify: () => {},
	};

	it("renders an enabled brain (no .off) when the map carries truth despite off-only levels", () => {
		const html = renderToStaticMarkup(
			createElement(StatusBar, {
				...base,
				status: status({
					model: model({ reasoning: false, thinkingLevelMap: { off: "none", low: "low" } }),
					thinkingLevels: ["off"],
				}),
			}),
		);
		expect(html).toMatch(/class="brain\s*"/); // enabled — no off modifier
		expect(html).not.toContain("brain off");
	});

	it("renders .off for non-thinking models", () => {
		const html = renderToStaticMarkup(
			createElement(StatusBar, {
				...base,
				status: status({
					model: model({ reasoning: false, thinkingLevelMap: {} }),
					thinkingLevels: ["off"],
				}),
			}),
		);
		expect(html).toContain('class="brain off"');
	});
});

describe("status-bar alignment (#48 style assertions)", () => {
	const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

	it("the content strip is exactly centered — one height, symmetric horizontal padding, safe-area band below", () => {
		const rule = /\.status-bar \{[^}]+\}/.exec(css)?.[0] ?? "";
		expect(rule).toContain("align-items: center");
		expect(rule).toContain("height: calc(36px + env(safe-area-inset-bottom))");
		expect(rule).toContain("padding: 0 16px env(safe-area-inset-bottom)");
		// the old asymmetric vertical padding (4px top vs 8px+inset bottom) is gone
		expect(rule).not.toContain("min-height: 36px");
	});

	it("the brain container centers its glyph", () => {
		const rule = /\.status-bar \.brain \{[^}]+\}/.exec(css)?.[0] ?? "";
		expect(rule).toContain("display: flex");
		expect(rule).toContain("align-items: center");
		expect(rule).toContain("justify-content: center");
	});
});
