// Theme contrast tests (#35) — the web twin of the Android
// MarkdownContrastTest: parse tokens.css, and pin the pairs the code chips
// use (text/surface >= 4.5:1, dim/surface >= 3:1) plus the peer-bubble
// override that keeps code chips readable inside tinted bubbles.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "src", "tokens.css"), "utf8");

function parseThemes(): Array<Record<string, string>> {
	const themes: Array<Record<string, string>> = [];
	const blocks = css.split("}").filter((b) => b.includes("--surface"));
	for (const block of blocks) {
		const vars: Record<string, string> = {};
		for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]+)\s*;/g)) {
			vars[m[1]!] = m[2]!;
		}
		if (vars.text && vars.surface) themes.push(vars);
	}
	return themes;
}

function luminance(hex: string): number {
	const h = hex.replace("#", "");
	const r = Number.parseInt(h.slice(0, 2), 16) / 255;
	const g = Number.parseInt(h.slice(2, 4), 16) / 255;
	const b = Number.parseInt(h.slice(4, 6), 16) / 255;
	const ch = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("theme contrast (#35: code chips must be readable in every theme)", () => {
	const themes = parseThemes();

	it("parses all five themes", () => {
		expect(themes.length).toBeGreaterThanOrEqual(5);
	});

	it("text on surface (code-chip ink) passes WCAG AA in every theme", () => {
		for (const t of themes) {
			const ratio = contrast(t.text!, t.surface!);
			expect(
				ratio,
				`text ${t.text} on surface ${t.surface} in theme ${t.name ?? "?"} (${t.text})`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("dim on surface (copy button) stays legible in every theme", () => {
		for (const t of themes) {
			if (!t.dim) continue;
			const ratio = contrast(t.dim, t.surface!);
			expect(ratio).toBeGreaterThanOrEqual(3.0);
		}
	});

	it("peer bubbles override the code-chip ink (the dark-on-dark fix is present)", () => {
		const styles = readFileSync(join(here, "..", "src", "styles.css"), "utf8");
		expect(styles).toMatch(/\.bubble\.peer-msg \.md-code-i[\s\S]*?color:\s*var\(--text\)/);
		expect(styles).toMatch(/\.bubble\.peer-msg \.md-pre[\s\S]*?color:\s*var\(--text\)/);
		expect(styles).toMatch(/\.bubble\.peer-msg \.md-table th[\s\S]*?color:\s*var\(--text\)/);
	});
});
