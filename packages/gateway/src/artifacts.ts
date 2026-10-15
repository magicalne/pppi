import { createHash } from "node:crypto";
import type { Artifact, ArtifactKind, ChatEntry } from "@pppi/protocol";

/**
 * Artifacts — issue #17. Agents deliver rich, self-contained views inside an
 * ordinary reply as fenced blocks:
 *
 *   ```pppi-artifact title="Build report"
 *   <!doctype html>…self-contained, no network…</html>
 *   ```
 *
 * The gateway extracts them at every boundary where text goes OUT to clients
 * (assistant_final broadcasts, delegated replies, hello history, history
 * pages) — stored text (pi's session, peerLog) stays raw, so extraction is
 * idempotent and needs no schema on the agent side: an artifact is just a
 * fenced code block until the gateway peels it off.
 *
 * Fence rules (mirrors the markdown renderer):
 * - opening fence: 3+ backticks/tildes + info string starting with `pppi-artifact`
 * - closing fence: same char, at least as many marks, own line
 * - info attrs: title="…" or title=bare-word (default "Untitled artifact"),
 *   kind=html (default; v1 supports html only — other kinds are LEFT AS PLAIN
 *   CODE so old clients and future kinds degrade safely)
 * - artifact ids are content-hashed → stable across reconnects/history pages
 */

export const ARTIFACT_FENCE = "pppi-artifact";
const SUPPORTED_KINDS: ReadonlySet<string> = new Set(["html"]);

const OPEN_RE = /^( {0,3})(`{3,}|~{3,})\s*pppi-artifact(.*)$/;

/** parse ` title="Build report" kind=html` → { title, kind } */
export function parseArtifactInfo(info: string): { title: string; kind: string | null } {
	let title = "";
	let kind: string | null = null;
	const re = /(title|kind)=("(?:[^"]*)"|'(?:[^']*)'|[^\s]+)/g;
	for (const m of info.matchAll(re)) {
		const key = m[1]!;
		let value = m[2]!;
		if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
		if (key === "title") title = value;
		else if (key === "kind") kind = value;
	}
	return { title: title.trim() || "Untitled artifact", kind };
}

export type ExtractedArtifacts = { text: string; artifacts: Artifact[] };

/** Pull artifact fences out of a reply; the returned text is chat-clean. */
export function extractArtifacts(text: string): ExtractedArtifacts {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	const artifacts: Artifact[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const open = OPEN_RE.exec(line);
		if (!open) {
			out.push(line);
			i++;
			continue;
		}
		const marker = open[2]!;
		const info = parseArtifactInfo(open[3] ?? "");
		const kind = info.kind ?? "html";
		const closeRe = new RegExp(`^[ \\t]{0,3}${marker[0] === "`" ? "\\`" : "~"}{${marker.length},}[ \\t]*$`);
		i++;
		const body: string[] = [];
		let closeLine: string | null = null;
		while (i < lines.length) {
			if (closeRe.test(lines[i]!)) {
				closeLine = lines[i]!;
				i++;
				break;
			}
			body.push(lines[i]!);
			i++;
		}
		const content = body.join("\n").trim();
		// not a v1 artifact → keep the fence as a plain code block:
		// unclosed (mid-stream delta text), empty, or a future kind (svg/mermaid)
		const passthrough = closeLine === null || content === "" || !SUPPORTED_KINDS.has(kind);
		if (passthrough) {
			out.push(line);
			out.push(...body);
			if (closeLine !== null) out.push(closeLine);
			continue;
		}
		artifacts.push({
			id: artifactId(info.title, content),
			title: info.title,
			kind: "html" as ArtifactKind,
			content,
		});
	}
	const cleaned = squashBlanks(out.join("\n"));
	return { text: cleaned, artifacts };
}

/** stable id per (title, content) — reconnects and history pages agree */
export function artifactId(title: string, content: string): string {
	return `art-${createHash("sha1").update(`${title}\n${content}`).digest("hex").slice(0, 12)}`;
}

/** collapse the runs of blank lines artifact extraction can leave behind */
function squashBlanks(text: string): string {
	return text
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "")
		.trim();
}

/** ChatEntry-shaped entry → entry with the text cleaned and artifacts attached */
export function entryWithArtifacts<T extends ChatEntry>(entry: T): T {
	if (entry.role !== "assistant" || !entry.text.includes(ARTIFACT_FENCE)) return entry;
	const { text, artifacts } = extractArtifacts(entry.text);
	if (artifacts.length === 0) return entry;
	return { ...entry, text, artifacts };
}
