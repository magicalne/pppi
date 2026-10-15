import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Block, Markdown, parseBlocks, parseInline } from "../src/markdown.tsx";

/** render a message body to static HTML — no DOM needed */
const R = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe("markdown: links", () => {
	it("renders markdown links with target=_blank + rel=noopener", () => {
		const html = R("see [pi](https://github.com/earendil-works/pi-coding-agent) for docs");
		expect(html).toContain('<a href="https://github.com/earendil-works/pi-coding-agent"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain(">pi</a>");
	});

	it("autolinks bare URLs", () => {
		expect(R("go to https://example.com/a?b=1 now")).toContain('<a href="https://example.com/a?b=1"');
	});

	it("strips sentence punctuation from bare URLs", () => {
		const html = R("visit https://example.com/x. then rest");
		expect(html).toContain('<a href="https://example.com/x"');
	});

	it("keeps balanced parens inside bare URLs", () => {
		const html = R("ref (https://en.wikipedia.org/wiki/Foo_(bar)) ok");
		expect(html).toContain('<a href="https://en.wikipedia.org/wiki/Foo_(bar)"');
	});

	it("renders angle autolinks", () => {
		expect(R("<https://example.com>")).toContain('<a href="https://example.com/"');
	});

	it("allows code spans inside link labels", () => {
		const html = R("run [`pi --rpc`](https://example.com/rpc)");
		expect(html).toContain("<a ");
		expect(html).toContain("<code");
	});

	it("renders images as links (no remote fetch)", () => {
		const html = R("![chart](https://example.com/chart.png)");
		expect(html).toContain('<a href="https://example.com/chart.png"');
		expect(html).not.toContain("<img");
	});
});

describe("markdown: inline styles", () => {
	it("bold, italic, nested emphasis, inline code", () => {
		const html = R("**bold** *ital* ***both*** `x = 1`");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>ital</em>");
		expect(html).toContain("<strong><em>both</em></strong>");
		expect(html).toContain('<code class="md-code-i">x = 1</code>');
	});

	it("unclosed emphasis stays literal", () => {
		const html = R("hello **world");
		expect(html).not.toContain("<strong>");
		expect(html).toContain("hello **world");
	});

	it("backslash escapes punctuation", () => {
		const nodes = parseInline("\\*not em\\*");
		expect(nodes).toEqual([{ t: "text", s: "*not em*" }]);
	});

	it("underscore emphasis does not fire inside snake_case_words", () => {
		const html = R("snake_case_name stays plain");
		expect(html).not.toContain("<em>");
	});

	it("code span wins over emphasis inside backticks", () => {
		const nodes = parseInline("`a *b* c`");
		expect(nodes).toEqual([{ t: "code", s: "a *b* c" }]);
	});
});

describe("markdown: blocks", () => {
	it("fenced code renders as a mono pre block", () => {
		const html = R("```ts\nconst a = 1;\nconst b = 2;\n```");
		expect(html).toContain('<pre class="md-pre">');
		expect(html).toContain("const a = 1;\nconst b = 2;");
	});

	it("an open fence at EOF is still a code block (streaming)", () => {
		const blocks = parseBlocks("```js\nlet a = 1;");
		expect(blocks).toEqual([{ k: "code", lang: "js", s: "let a = 1;" }]);
	});

	it("unordered and ordered lists", () => {
		const html = R("- a\n- b\n- c");
		expect(html).toContain("<ul");
		expect((html.match(/<li>/g) ?? []).length).toBe(3);

		const ordered = R("2. second\n3. third");
		expect(ordered).toContain('start="2"');
		expect((ordered.match(/<li>/g) ?? []).length).toBe(2);
	});

	it("single-newline paragraphs keep line breaks", () => {
		const html = R("line one\nline two");
		expect(html).toContain("line one<br/>line two");
	});

	it("blockquotes nest blocks", () => {
		const html = R("> quoted\n>\n> more");
		expect(html).toContain("<blockquote");
		expect(html).toContain("quoted");
		expect(html).toContain("more");
	});

	it("tables render with header alignment", () => {
		const html = R("| Name | Score |\n|:-----|------:|\n| pi | 42 |\n| omni | 7 |");
		expect(html).toContain("<table");
		expect(html).toContain("text-align:left");
		expect(html).toContain("text-align:right");
		expect(html).toContain(">Name</th>");
		expect(html).toContain(">pi</td>");
	});

	it("a table can interrupt a paragraph", () => {
		const blocks = parseBlocks("here:\n| a | b |\n|---|---|\n| 1 | 2 |");
		expect(blocks.map((b) => b.k)).toEqual(["para", "table"]);
	});

	it("headings and rules", () => {
		const html = R("## Title\n\n---\n\ntail");
		expect(html).toMatch(/<h2[^>]*>Title<\/h2>/);
		expect(html).toContain("<hr");
	});
});

describe("markdown: XSS safety", () => {
	it("escapes raw HTML in model output", () => {
		const html = R("<script>alert(1)</script>");
		expect(html).not.toContain("<script");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	it("escapes img/onerror payloads", () => {
		const html = R('<img src=x onerror="alert(1)"> plain');
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
		expect(html).not.toContain('onerror="alert(1)"');
	});

	it("never anchors javascript:/data: hrefs", () => {
		for (const href of [
			"javascript:alert(1)",
			"data:text/html;base64,PHNjcmlwdD4",
			"vbscript:x",
			"JaVaScRiPt:alert(1)",
		]) {
			const html = R(`[click](${href})`);
			expect(html).not.toContain("<a ");
			expect(html).toContain("click");
		}
	});

	it("neutralizes bare-URL javascript tricks", () => {
		const html = R("try javascript:alert(1) here");
		expect(html).not.toContain("<a ");
	});

	it("output tags are only from the allowlist", () => {
		const hostile = [
			"<script>alert(1)</script>",
			"<img src=x onerror=alert(1)>",
			"<a href='javascript:alert(1)'>x</a>",
			"<iframe src=//evil.example></iframe>",
			"<svg onload=alert(1)>",
			"[x](javascript:alert(1))",
			"```html\n<div onclick=alert(1)>code</div>\n```",
			"| <b>a</b> | c |\n|---|---|\n| <span>x</span> | y |",
		].join("\n\n");
		const html = R(hostile);
		const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase());
		const allowed = new Set([
			"div",
			"p",
			"br",
			"span",
			"a",
			"em",
			"strong",
			"code",
			"pre",
			"ul",
			"ol",
			"li",
			"blockquote",
			"hr",
			"table",
			"thead",
			"tbody",
			"tr",
			"th",
			"td",
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"h6",
		]);
		for (const tag of tags) expect(allowed.has(tag), `unexpected tag <${tag}> in ${html}`).toBe(true);
		// and anchors never carry an unsafe href
		for (const href of html.matchAll(/href="([^"]*)"/g)) {
			expect(href[1]!.startsWith("http")).toBe(true);
		}
	});
});

describe("markdown: streaming stability", () => {
	/**
	 * Core property: growing the text (assistant_delta chunks) never changes
	 * any block except the last one — so block-index-keyed DOM for everything
	 * but the streaming tail is reused and nothing flickers or jumps.
	 */
	function assertStableGrowth(doc: string, step = 1) {
		let prev: Block[] = [];
		for (let end = step; end <= doc.length; end += step) {
			const cur = parseBlocks(doc.slice(0, end));
			if (prev.length > 0) {
				const settled = prev.slice(0, -1); // everything but the tail
				expect(cur.slice(0, settled.length)).toEqual(settled);
			}
			prev = cur;
		}
	}

	const doc = [
		"Intro **bold** with a [link](https://example.com) and `code`.",
		"",
		"```python",
		"def f():",
		"    return 42",
		"```",
		"",
		"- item one",
		"- item two",
		"",
		"| a | b |",
		"|---|---|",
		"| 1 | 2 |",
		"",
		"> quoted words",
		"",
		"## Done",
	].join("\n");

	it("holds for char-by-char streaming", () => {
		assertStableGrowth(doc, 1);
	});

	it("holds for token-by-token streaming", () => {
		let prev: Block[] = [];
		let buf = "";
		for (const t of doc.split(/(\s+)/)) {
			buf += t;
			const cur = parseBlocks(buf);
			if (prev.length) expect(cur.slice(0, prev.slice(0, -1).length)).toEqual(prev.slice(0, -1));
			prev = cur;
		}
	});

	it("holds for a hostile-ish mixed document", () => {
		const tricky = [
			"steps: 1. first 2. second?",
			"",
			"```",
			"unclosed fence keeps absorbing",
			"",
			"|h|",
			"|-|",
			"|x|",
			"",
			"**unterminated emphasis",
		].join("\n");
		assertStableGrowth(tricky, 3);
	});

	it("partial table renders rows as they stream", () => {
		const blocks = parseBlocks("| a | b |\n|---|---|\n| 1 |");
		expect(blocks[0]!.k).toBe("table");
		const rows = (blocks[0] as { rows: unknown[][] }).rows;
		expect(rows.length).toBe(1);
	});
});
