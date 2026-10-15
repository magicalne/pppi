import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copyTextToClipboard } from "../src/copy.ts";
import { messageToPlainText } from "../src/plainText.ts";

describe("plain text projection (messageToPlainText)", () => {
	it("strips emphasis and link syntax, keeps code spans verbatim", () => {
		const out = messageToPlainText("**bold** and *ital* plus `x = 1`");
		expect(out).toBe("bold and ital plus x = 1");
	});

	it("links become label (url); bare/autolinks stay single", () => {
		expect(messageToPlainText("see [pi](https://example.com/pi) docs")).toBe("see pi (https://example.com/pi) docs");
		expect(messageToPlainText("go to https://example.com now")).toBe("go to https://example.com/ now");
		expect(messageToPlainText("<https://example.com/a>")).toBe("https://example.com/a");
		// label that already is the url — no duplication
		expect(messageToPlainText("[https://example.com](https://example.com/)")).toBe("https://example.com/");
	});

	it("fenced code is copied byte-for-byte (no artifacts, no fences)", () => {
		const out = messageToPlainText("intro\n\n```ts\nconst a = 1;\n\tconst b = {  x: 2 };  \n```");
		expect(out).toBe("intro\n\nconst a = 1;\n\tconst b = {  x: 2 };  ");
	});

	it("lists keep markers, ordered lists keep numbering, continuations indent", () => {
		expect(messageToPlainText("- a\n- b")).toBe("- a\n- b");
		expect(messageToPlainText("2. second\n3. third")).toBe("2. second\n3. third");
		expect(messageToPlainText("- item one\n  wrapped line")).toBe("- item one\n  wrapped line");
	});

	it("headings lose their hashes; quotes gain '> ' per line; hr survives", () => {
		expect(messageToPlainText("## Title")).toBe("Title");
		expect(messageToPlainText("> quoted\n>\n> more")).toBe("> quoted\n>\n> more");
		expect(messageToPlainText("---")).toBe("---");
	});

	it("tables project to pipe rows", () => {
		const out = messageToPlainText("| Name | Score |\n|:-----|------:|\n| pi | 42 |");
		expect(out).toBe("Name | Score\n--- | ---\npi | 42");
	});

	it("plain user-style text passes through unchanged", () => {
		expect(messageToPlainText("just a plain message\nwith two lines")).toBe("just a plain message\nwith two lines");
	});

	it("combined agent message keeps block order and spacing", () => {
		const out = messageToPlainText(
			"**Done.** See [docs](https://example.com/d).\n\n- one\n- two\n\n```js\nlet x;\n```",
		);
		expect(out).toBe("Done. See docs (https://example.com/d).\n\n- one\n- two\n\nlet x;");
	});
});

describe("clipboard write (copyTextToClipboard)", () => {
	it("prefers the async clipboard API when available", async () => {
		const calls: string[] = [];
		const ok = await copyTextToClipboard("hello", {
			writeText: async (t) => {
				calls.push(t);
			},
			execCopy: (t) => {
				calls.push(`exec:${t}`);
				return true;
			},
		});
		expect(ok).toBe(true);
		expect(calls).toEqual(["hello"]);
	});

	it("falls back to execCopy when the API throws (permission/not focused)", async () => {
		const ok = await copyTextToClipboard("hello", {
			writeText: async () => {
				throw new Error("NotAllowedError");
			},
			execCopy: (t) => t === "hello",
		});
		expect(ok).toBe(true);
	});

	it("falls back when there is no clipboard API (http LAN phone)", async () => {
		const ok = await copyTextToClipboard("hello", { execCopy: () => true });
		expect(ok).toBe(true);
	});

	it("reports false when both paths fail or are missing", async () => {
		expect(await copyTextToClipboard("x", { execCopy: () => false })).toBe(false);
		expect(
			await copyTextToClipboard("x", {
				writeText: async () => {
					throw new Error("denied");
				},
				execCopy: () => {
					throw new Error("unsupported");
				},
			}),
		).toBe(false);
		expect(await copyTextToClipboard("x")).toBe(false); // node: neither exists
	});
});

describe("selection regression guard (issue #12)", () => {
	it("message content explicitly opts into text selection in styles.css", () => {
		const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
		for (const selector of [".assistant-msg", ".bubble.user-msg", ".bubble.peer-msg", ".toolchip"]) {
			// find the rule block for the selector and assert it (or a group containing
			// it) declares user-select: text
			const rule = new RegExp(`${selector.replace(".", "\\.")}[^{]*\\{[^}]*\\}`, "g");
			const blocks = css.match(rule) ?? [];
			expect(blocks.length, `expected a rule for ${selector}`).toBeGreaterThan(0);
			const optsIn = blocks.some((b) => /user-select:\s*text/.test(b));
			expect(optsIn, `${selector} must pin user-select: text`).toBe(true);
		}
		// nothing may strip selection from message bodies again
		const msgRules = css.match(/^(\.(assistant-msg|bubble|md(?=[ ,.>{])|toolchip)[^{]*)\{[^}]*\}/gm) ?? [];
		for (const rule of msgRules) {
			expect(rule.includes("user-select: none"), `${rule} would block long-press selection`).toBe(false);
		}
	});
});
