import { type Block, type Inline, parseBlocks } from "./markdown.tsx";

/**
 * Plain-text projection of a markdown message — issue #12.
 *
 * Used by the per-message Copy affordance: the user gets the message CONTENT,
 * not its formatting. Emphasis markers vanish, link syntax becomes
 * "label (url)" (label alone when it already is the url), fenced code is kept
 * byte-for-byte (copying code must never lose whitespace), lists keep their
 * markers so structure survives in a paste target.
 */

function inlineText(nodes: Inline[]): string {
	let out = "";
	for (const n of nodes) {
		switch (n.t) {
			case "text":
				out += n.s; // keeps \n soft breaks
				break;
			case "code":
				out += n.s;
				break;
			case "strong":
			case "em":
				out += inlineText(n.c);
				break;
			case "link": {
				const label = inlineText(n.c).replace(/\s+/g, " ").trim();
				const href = n.href.replace(/\/$/, "");
				// autolinks/bare URLs: don't paste "https://x (https://x)"
				if (!label || label.toLowerCase() === href.toLowerCase() || label === n.href) out += n.href;
				else out += `${label} (${n.href})`;
				break;
			}
		}
	}
	return out;
}

function blockText(b: Block): string {
	switch (b.k) {
		case "para":
			return inlineText(b.c);
		case "heading":
			return inlineText(b.c);
		case "code":
			return b.s; // raw — code copies must be exact
		case "hr":
			return "---";
		case "quote":
			return b.c
				.map(blockText)
				.join("\n\n")
				.split("\n")
				.map((l) => `> ${l}`.trimEnd())
				.join("\n");
		case "list":
			return b.items
				.map((item, i) => `${b.ordered ? `${b.start + i}. ` : "- "}${inlineText(item).replace(/\n/g, "\n  ")}`)
				.join("\n");
		case "table": {
			const row = (cells: Inline[][]) => cells.map((c) => inlineText(c).replace(/\n/g, " ")).join(" | ");
			const lines = [row(b.head), b.head.map(() => "---").join(" | ")];
			for (const r of b.rows) lines.push(row(r));
			return lines.join("\n");
		}
	}
}

/** Full plain text of a (possibly markdown) message body. */
export function messageToPlainText(src: string): string {
	return parseBlocks(src)
		.map(blockText)
		.filter((t) => t !== "")
		.join("\n\n");
}
