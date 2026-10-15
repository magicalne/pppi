import { type ReactNode, useMemo } from "react";
import { copyTextToClipboard } from "./copy.ts";

/**
 * Minimal markdown renderer for chat messages — issue #16.
 *
 * Why hand-rolled instead of marked/markdown-it + DOMPurify: those produce
 * HTML strings, which must then go through `dangerouslySetInnerHTML` and a
 * sanitizer (DOMPurify needs a DOM at runtime). Parsing straight into React
 * elements is XSS-safe by construction — React escapes every text node, and
 * the only elements ever created come from this allowlist — so no sanitizer,
 * no HTML string, no new dependency. v1 covers what agents actually emit:
 * links (incl. bare-URL autolinks), emphasis, code spans, fenced code, ATX
 * headings, lists, blockquotes, tables, hr. Raw HTML is never passed through;
 * it renders as literal, escaped text. No images in v1 (LAN-first client —
 * `![alt](url)` renders as a link with the alt text as label).
 *
 * Streaming stability: parsing is a pure function of the text and block
 * classification only looks at a line and its successor, so growing the text
 * (assistant_delta) never changes any block except the last one. Blocks are
 * rendered with index keys, so earlier DOM nodes are reused unchanged — no
 * flicker while text arrives.
 */

// ---------------------------------------------------------------- inline AST

export type Inline =
	| { t: "text"; s: string }
	| { t: "code"; s: string }
	| { t: "strong"; c: Inline[] }
	| { t: "em"; c: Inline[] }
	| { t: "link"; href: string; c: Inline[] };

// ---------------------------------------------------------------- block AST

export type Block =
	| { k: "para"; c: Inline[] }
	| { k: "heading"; level: number; c: Inline[] }
	| { k: "code"; lang: string; s: string }
	| { k: "hr" }
	| { k: "quote"; c: Block[] }
	| { k: "list"; ordered: boolean; start: number; items: Inline[][] }
	| { k: "table"; align: ("left" | "center" | "right" | undefined)[]; head: Inline[][]; rows: Inline[][][] };

// ---------------------------------------------------------------- link safety

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Only http(s)/mailto URLs become anchors — javascript:, data:, … never do. */
function safeHref(raw: string): string | null {
	const s = raw.trim();
	if (!s || /[\s<>"']/.test(s)) return null;
	try {
		const u = new URL(s);
		return SAFE_PROTOCOLS.has(u.protocol) ? u.toString() : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- inline parse

/** index of the `]` matching the `[` at `start`, or -1 */
function findCloseBracket(s: string, start: number): number {
	let depth = 0;
	for (let i = start; i < s.length; i++) {
		const ch = s[i]!;
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** trim sentence punctuation that is almost never part of a bare URL */
function trimUrlTail(url: string): string {
	let u = url;
	while (u.length > 8 && /[.,;:!?]+$/.test(u)) u = u.slice(0, -1);
	while (u.endsWith(")")) {
		const opens = (u.match(/\(/g) ?? []).length;
		const closes = (u.match(/\)/g) ?? []).length;
		if (closes > opens) u = u.slice(0, -1);
		else break;
	}
	return u;
}

const AUTOLINK_RE = /^<(https?:\/\/[^>\s]+)>/i;
const BARE_URL_RE = /^https?:\/\/[^\s<>"']+/i;

export function parseInline(src: string): Inline[] {
	const out: Inline[] = [];
	let buf = "";
	const flush = () => {
		if (buf) {
			out.push({ t: "text", s: buf });
			buf = "";
		}
	};
	let i = 0;
	while (i < src.length) {
		const rest = src.slice(i);
		const ch = rest[0]!;

		// backslash escape of ASCII punctuation → literal char
		if (ch === "\\" && rest[1] && /[!-/:-@[-`{-~]/.test(rest[1]!)) {
			buf += rest[1]!;
			i += 2;
			continue;
		}

		// code span: run of n backticks closed by another run of n backticks
		if (ch === "`") {
			const run = /^`+/.exec(rest)![0];
			let idx = rest.indexOf(run, run.length);
			while (idx !== -1 && (rest[idx - 1] === "`" || rest[idx + run.length] === "`")) {
				idx = rest.indexOf(run, idx + 1);
			}
			if (idx !== -1) {
				let content = rest.slice(run.length, idx);
				if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && !/^ *$/.test(content)) {
					content = content.slice(1, -1);
				}
				flush();
				out.push({ t: "code", s: content });
				i += idx + run.length;
				continue;
			}
			buf += run; // unclosed → literal
			i += run.length;
			continue;
		}

		// link / image-as-link: [label](url) — label may nest brackets/escapes
		if (ch === "[" || (ch === "!" && rest[1] === "[")) {
			const bang = ch === "!" ? 1 : 0;
			const close = findCloseBracket(rest, bang);
			if (close !== -1) {
				const label = rest.slice(bang + 1, close);
				const after = rest.slice(close + 1);
				if (after.startsWith("(")) {
					// href runs to the matching ")" (depth-aware, no newlines involved)
					let depth = 1;
					let end = -1;
					for (let j = 1; j < after.length; j++) {
						const c2 = after[j]!;
						if (c2 === "\\") {
							j++;
							continue;
						}
						if (c2 === "(") depth++;
						else if (c2 === ")") {
							depth--;
							if (depth === 0) {
								end = j;
								break;
							}
						}
					}
					const m = end > 1 ? /^\s*([^)\s]+)\s*(?:"[^"]*"|'[^']*')?\s*$/.exec(after.slice(1, end)) : null;
					if (m) {
						let raw = m[1]!;
						if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1);
						const href = safeHref(raw);
						const labelInline = parseInline(label);
						if (href) {
							flush();
							out.push({ t: "link", href, c: labelInline });
						} else {
							// unsafe scheme: keep the label as plain text, drop the URL
							buf += label;
						}
						i += close + 1 + end + 1;
						continue;
					}
				}
			}
			buf += bang ? "![" : "[";
			i += bang + 1;
			continue;
		}

		// angle autolink <https://…> — anything else angle-bracketed stays literal
		const auto = AUTOLINK_RE.exec(rest);
		if (ch === "<" && auto) {
			const href = safeHref(auto[1]!);
			if (href) {
				flush();
				out.push({ t: "link", href, c: [{ t: "text", s: auto[1]! }] });
			} else {
				buf += "<";
			}
			i += auto[0].length;
			continue;
		}

		// bare URL autolink (must start after whitespace, "(" or "[")
		const bare = BARE_URL_RE.exec(rest);
		if (bare && (i === 0 || /[\s([]/.test(src[i - 1]!))) {
			const url = trimUrlTail(bare[0]);
			const href = safeHref(url);
			if (href) {
				flush();
				out.push({ t: "link", href, c: [{ t: "text", s: url }] });
				i += bare[0].length;
				continue;
			}
		}

		// emphasis: ***both*** → strong(em), **strong**, *em* (and _ twins)
		if ((ch === "*" || ch === "_") && rest.length >= 3 && rest[0] === rest[1] && rest[1] === rest[2]) {
			const close = rest.indexOf(rest.slice(0, 3), 3);
			if (close > 3) {
				flush();
				out.push({ t: "strong", c: [{ t: "em", c: parseInline(rest.slice(3, close)) }] });
				i += close + 3;
				continue;
			}
		}
		if ((ch === "*" || ch === "_") && rest[1] === ch) {
			const close = rest.indexOf(rest.slice(0, 2), 2);
			if (close > 2) {
				flush();
				out.push({ t: "strong", c: parseInline(rest.slice(2, close)) });
				i += close + 2;
				continue;
			}
		}
		if (ch === "*" || (ch === "_" && (i === 0 || !/\w/.test(src[i - 1]!)))) {
			const next = rest[1] ?? "";
			if (next && !/\s/.test(next)) {
				const close = rest.indexOf(ch, 1);
				if (close > 1 && (ch === "*" || !/\w/.test(rest[close + 1] ?? ""))) {
					flush();
					out.push({ t: "em", c: parseInline(rest.slice(1, close)) });
					i += close + 1;
					continue;
				}
			}
		}

		buf += ch;
		i++;
	}
	flush();
	return out;
}

// ---------------------------------------------------------------- block parse

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^ {0,3}([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;

function isDelimiterRow(l: string): boolean {
	const t = l.trim();
	if (!t.includes("|") || !t.includes("-")) return false;
	let s = t;
	if (s.startsWith("|")) s = t.slice(1);
	s = s.replace(/[ \t]+$/, "");
	if (s.endsWith("|")) s = s.slice(0, -1);
	return s.split("|").every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function isTableRow(l: string): boolean {
	const t = l.trim();
	return t.length > 0 && t.includes("|") && !isDelimiterRow(t);
}

/** split a table row into trimmed cells (`\|` escapes a literal pipe) */
function splitCells(l: string): string[] {
	let t = l.trim();
	if (t.startsWith("|")) t = t.slice(1);
	t = t.replace(/[ \t]+$/, "");
	if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < t.length; i++) {
		const c = t[i]!;
		if (c === "\\" && t[i + 1] === "|") {
			cur += "|";
			i++;
			continue;
		}
		if (c === "|") {
			cells.push(cur.trim());
			cur = "";
			continue;
		}
		cur += c;
	}
	cells.push(cur.trim());
	return cells;
}

function alignmentOf(cell: string): "left" | "center" | "right" | undefined {
	const m = /^(:?)(-+)(:?)$/.exec(cell.trim());
	if (!m) return undefined;
	if (m[1] && m[3]) return "center";
	if (m[3]) return "right";
	if (m[1]) return "left";
	return undefined;
}

/** can the line at `i` start a new block (interrupting a paragraph/list)? */
function isBlockStart(lines: string[], i: number): boolean {
	const l = lines[i]!;
	if (FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l)) return true;
	return isTableRow(l) && i + 1 < lines.length && isDelimiterRow(lines[i + 1]!);
}

export function parseBlocks(src: string): Block[] {
	const lines = src.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;

		if (/^\s*$/.test(line)) {
			i++;
			continue;
		}

		// fenced code — an open fence at EOF is still a code block (streaming)
		const fence = FENCE_RE.exec(line);
		if (fence) {
			const marker = fence[1]!;
			const info = fence[2]!.trim();
			const lang = info ? info.split(/\s+/)[0]! : "";
			i++;
			const body: string[] = [];
			while (i < lines.length) {
				const l = lines[i]!;
				const closeM = /^[ \t]{0,3}([`~]+)[ \t]*$/.exec(l);
				if (closeM && closeM[1]![0] === marker[0] && closeM[1]!.length >= marker.length) {
					i++;
					break;
				}
				body.push(l);
				i++;
			}
			blocks.push({ k: "code", lang, s: body.join("\n") });
			continue;
		}

		// ATX heading
		const heading = HEADING_RE.exec(line);
		if (heading) {
			const text = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
			blocks.push({ k: "heading", level: heading[1]!.length, c: parseInline(text) });
			i++;
			continue;
		}

		// horizontal rule
		if (HR_RE.test(line)) {
			blocks.push({ k: "hr" });
			i++;
			continue;
		}

		// blockquote (recursively parsed)
		if (QUOTE_RE.test(line)) {
			const inner: string[] = [];
			while (i < lines.length && QUOTE_RE.test(lines[i]!)) {
				inner.push(lines[i]!.replace(/^ {0,3}>[ \t]?/, ""));
				i++;
			}
			blocks.push({ k: "quote", c: parseBlocks(inner.join("\n")) });
			continue;
		}

		// GFM table: header row + delimiter row, then body rows
		if (isTableRow(line) && i + 1 < lines.length && isDelimiterRow(lines[i + 1]!)) {
			const head = splitCells(line);
			const align = splitCells(lines[i + 1]!).map((c) => alignmentOf(c) ?? undefined);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && isTableRow(lines[i]!)) {
				rows.push(splitCells(lines[i]!));
				i++;
			}
			blocks.push({
				k: "table",
				align: head.map((_, c) => align[c]),
				head: head.map((c) => parseInline(c)),
				rows: rows.map(
					(r) => head.map((_, c) => parseInline(r[c] ?? "")), // GFM: pad short rows, drop extras
				),
			});
			continue;
		}

		// list — flat in v1; continuation lines (incl. lazy) join the last item
		const list = LIST_RE.exec(line);
		if (list) {
			const ordered = /\d/.test(list[1]!);
			const start = ordered ? Number.parseInt(list[1]!, 10) : 1;
			const items: string[] = [list[2] ?? ""];
			i++;
			while (i < lines.length) {
				const l = lines[i]!;
				if (/^\s*$/.test(l)) break;
				const item = LIST_RE.exec(l);
				if (item) {
					items.push(item[2] ?? "");
					i++;
					continue;
				}
				// a new block ends the list (another list item was handled above)
				if (FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l)) break;
				if (isTableRow(l) && i + 1 < lines.length && isDelimiterRow(lines[i + 1]!)) break;
				const cont = l.replace(/^ {1,4}/, "");
				items[items.length - 1] = items[items.length - 1] ? `${items[items.length - 1]}\n${cont}` : cont;
				i++;
			}
			blocks.push({ k: "list", ordered, start, items: items.map((it) => parseInline(it)) });
			continue;
		}

		// paragraph — single newlines are line breaks (how agents write)
		const para: string[] = [];
		while (i < lines.length && !/^\s*$/.test(lines[i]!) && !isBlockStart(lines, i)) {
			para.push(lines[i]!);
			i++;
		}
		blocks.push({ k: "para", c: parseInline(para.join("\n")) });
	}
	return blocks;
}

// ---------------------------------------------------------------- render

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** code-block copy: write the RAW code (no artifacts), flash ✓ / ✕ on the button */
async function flashCopied(btn: HTMLButtonElement, code: string) {
	const ok = await copyTextToClipboard(code);
	btn.classList.add(ok ? "ok" : "fail");
	btn.textContent = ok ? "✓" : "✕";
	setTimeout(() => {
		btn.classList.remove("ok", "fail");
		btn.textContent = "⧉";
	}, 1400);
}

/** text node with `\n` soft breaks rendered as <br> */
function textWithBreaks(s: string, key: string): ReactNode {
	const parts = s.split("\n");
	if (parts.length === 1) return s || null;
	return (
		<span key={key}>
			{/* biome-ignore lint/suspicious/noArrayIndexKey: derived data — positional keys keep streaming text stable */}
			{parts.flatMap((p, idx) => (idx === 0 ? [p] : [<br key={`br${idx}`} />, p]))}
		</span>
	);
}

function renderInline(nodes: Inline[], keyPrefix = ""): ReactNode[] {
	return nodes.map((n, i) => {
		const key = `${keyPrefix}${i}`;
		switch (n.t) {
			case "text":
				return textWithBreaks(n.s, key);
			case "code":
				return (
					<code key={key} className="md-code-i">
						{n.s}
					</code>
				);
			case "strong":
				return <strong key={key}>{renderInline(n.c, `${key}-`)}</strong>;
			case "em":
				return <em key={key}>{renderInline(n.c, `${key}-`)}</em>;
			case "link":
				return (
					<a key={key} href={n.href} target="_blank" rel="noopener noreferrer">
						{renderInline(n.c, `${key}-`)}
					</a>
				);
		}
	});
}

function renderBlock(b: Block, key: string): ReactNode {
	switch (b.k) {
		case "para":
			return (
				<p key={key} className="md-p">
					{renderInline(b.c)}
				</p>
			);
		case "heading": {
			const H = HEADING_TAGS[b.level - 1] ?? "h6";
			return (
				<H key={key} className={`md-h md-h${b.level}`}>
					{renderInline(b.c)}
				</H>
			);
		}
		case "code":
			return (
				<div key={key} className="md-code-wrap">
					<button
						type="button"
						className="md-code-copy"
						aria-label="Copy code"
						onClick={(e) => flashCopied(e.currentTarget, b.s)}
					>
						⧉
					</button>
					<pre className="md-pre">
						<code>{b.s}</code>
					</pre>
				</div>
			);
		case "hr":
			return <hr key={key} className="md-hr" />;
		case "quote":
			return (
				<blockquote key={key} className="md-quote">
					{b.c.map((q, i) => renderBlock(q, `${key}-${i}`))}
				</blockquote>
			);
		case "list": {
			const L = b.ordered ? "ol" : "ul";
			return (
				<L key={key} className="md-list" start={b.ordered && b.start !== 1 ? b.start : undefined}>
					{b.items.map((it, i) => {
						// biome-ignore lint/suspicious/noArrayIndexKey: derived data — positional keys keep streaming text stable
						return <li key={`${key}-${i}`}>{renderInline(it, `${key}-${i}-`)}</li>;
					})}
				</L>
			);
		}
		case "table":
			return (
				<div key={key} className="md-table-wrap">
					<table className="md-table">
						<thead>
							<tr>
								{b.head.map((cell, i) => {
									return (
										// biome-ignore lint/suspicious/noArrayIndexKey: derived data — positional keys keep streaming text stable
										<th key={i} style={b.align[i] ? { textAlign: b.align[i] } : undefined}>
											{renderInline(cell, `h${i}-`)}
										</th>
									);
								})}
							</tr>
						</thead>
						{b.rows.length > 0 && (
							<tbody>
								{b.rows.map((row, r) => {
									return (
										// biome-ignore lint/suspicious/noArrayIndexKey: derived data — positional keys keep streaming text stable
										<tr key={r}>
											{row.map((cell, c) => {
												return (
													// biome-ignore lint/suspicious/noArrayIndexKey: derived data — positional keys keep streaming text stable
													<td key={c} style={b.align[c] ? { textAlign: b.align[c] } : undefined}>
														{renderInline(cell, `r${r}c${c}-`)}
													</td>
												);
											})}
										</tr>
									);
								})}
							</tbody>
						)}
					</table>
				</div>
			);
	}
	return null;
}

export function Markdown({ text }: { text: string }) {
	const blocks = useMemo(() => parseBlocks(text), [text]);
	if (blocks.length === 0) return null;
	return <div className="md">{blocks.map((b, i) => renderBlock(b, `b${i}`))}</div>;
}
