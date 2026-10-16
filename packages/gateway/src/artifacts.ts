import { createHash } from "node:crypto";
import type { Artifact, ArtifactKind, ChatEntry, TaskUpdate } from "@pppi/protocol";

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

const OPEN_RE = /^( {0,3})(`{3,}|~{3,})\s*pppi-(artifact|task)(.*)$/;

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
		const type = open[3]!;
		if (type !== "artifact") {
			// task fences pass through the artifact scanner untouched (#15)
			out.push(line);
			i++;
			continue;
		}
		const info = parseArtifactInfo(open[4] ?? "");
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

// ---------------------------------------------------------------- tasks (#15)

const TASK_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "done", "failed"]);

/** parse ` id=deploy title="Ship it" status=running detail="pushing…"` */
export function parseTaskInfo(info: string): {
	id: string;
	title: string;
	status: TaskUpdate["status"];
	detail?: string;
	valid: boolean;
} {
	const vals: Record<string, string> = {};
	const re = /(id|title|status|detail)=("(?:[^"]*)"|'(?:[^']*)'|[^\s]+)/g;
	for (const m of info.matchAll(re)) {
		let v = m[2]!;
		if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
		vals[m[1]!] = v;
	}
	const id = vals.id ?? "";
	const status = vals.status ?? "running";
	return {
		id,
		title: vals.title?.trim() || id,
		status: status as TaskUpdate["status"],
		detail: vals.detail,
		// id required; unknown statuses degrade to a plain code block (#28 pattern)
		valid: id !== "" && TASK_STATUSES.has(status),
	};
}

export type ExtractedTasks = { text: string; tasks: TaskUpdate[] };

/** Pull ```pppi-task fences out of a reply (same boundary contract as artifacts). */
export function extractTasks(text: string): ExtractedTasks {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	const tasks: TaskUpdate[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const open = OPEN_RE.exec(line);
		if (!open || open[3] !== "task") {
			out.push(line);
			i++;
			continue;
		}
		const marker = open[2]!;
		const info = parseTaskInfo(open[4] ?? "");
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
		if (!info.valid || closeLine === null || body.join("\n").trim() !== "") {
			// malformed / unknown status / stray content — keep as plain code
			out.push(line);
			out.push(...body);
			if (closeLine !== null) out.push(closeLine);
			continue;
		}
		tasks.push({
			id: info.id,
			title: info.title,
			status: info.status,
			...(info.detail ? { detail: info.detail } : {}),
		});
	}
	const cleaned = squashBlanks(out.join("\n"));
	return { text: cleaned, tasks };
}

/** entry → text cleaned, artifacts AND tasks attached (#17 + #15) */
export function entryWithArtifacts<T extends ChatEntry>(entry: T): T {
	if (entry.role !== "assistant") return entry;
	if (!entry.text.includes("pppi-")) return entry;
	const arts = extractArtifacts(entry.text);
	const both = extractTasks(arts.text);
	const text = both.text;
	if (arts.artifacts.length === 0 && both.tasks.length === 0) return entry;
	return {
		...entry,
		text,
		...(arts.artifacts.length ? { artifacts: arts.artifacts } : {}),
		...(both.tasks.length ? { tasks: both.tasks } : {}),
	};
}
