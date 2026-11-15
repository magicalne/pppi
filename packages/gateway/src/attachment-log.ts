// Attachment history log (#50 v1 gap, closed in v2 #59): the gateway
// appends every chat-with-attachments to ~/.pppi/uploads/messages.jsonl and
// merges them back into hello/history entries on reload. ChatEntry ids are
// regenerated per fetch (randomUUID), so records key on the stable pi
// timestamp + text prefix instead.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment, ChatEntry } from "@pppi/protocol";
import { pppiDir } from "./config.ts";

type Record_ = { ts: number; text: string; attachments: Attachment[] };

let cache: Map<number, Record_[]> | null = null;

function logPath(): string {
	return join(pppiDir(), "uploads", "messages.jsonl");
}

function records(): Map<number, Record_[]> {
	if (cache) return cache;
	const map = new Map<number, Record_[]>();
	try {
		if (existsSync(logPath())) {
			for (const line of readFileSync(logPath(), "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const r = JSON.parse(line) as Record_;
					if (typeof r.ts === "number" && Array.isArray(r.attachments) && r.attachments.length > 0) {
						const list = map.get(r.ts) ?? [];
						list.push(r);
						map.set(r.ts, list);
					}
				} catch {
					// skip malformed lines
				}
			}
		}
	} catch {
		// unreadable log: behave as empty
	}
	cache = map;
	return map;
}

/** remember the attachments of a submitted chat message (fire-and-forget safe) */
export function recordAttachments(ts: number, text: string, attachments: Attachment[]): void {
	if (attachments.length === 0) return;
	const rec: Record_ = { ts, text: text.slice(0, 200), attachments };
	const list = records().get(ts) ?? [];
	list.push(rec);
	records().set(ts, list);
	try {
		appendFileSync(logPath(), `${JSON.stringify(rec)}\n`);
	} catch {
		// append failures degrade to in-memory only (this boot)
	}
}

/** merge logged attachments into ONE history entry: user-role entries match
 *  a record by timestamp proximity + text prefix. Pure over the inputs (the
 *  log is read via the cache) so it is unit-testable. */
export function withHistoryAttachments(e: ChatEntry): ChatEntry {
	if (e.role !== "user" || records().size === 0) return e;
	for (const [ts, list] of records()) {
		if (Math.abs(ts - e.ts) > 1500) continue;
		for (const r of list) {
			const a = r.text.trim().slice(0, 80);
			const b = e.text.trim().slice(0, 80);
			// chips-only sends carry empty text on both sides — that matches
			if (
				(a.length === 0 && b.length === 0) ||
				(a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a)))
			) {
				return { ...e, attachments: r.attachments };
			}
		}
	}
	return e;
}

/** tests + maintenance: reset the in-memory cache + truncate the log */
export function resetAttachmentLogForTest(): void {
	cache = null;
	try {
		if (existsSync(logPath())) writeFileSync(logPath(), "");
	} catch {
		// best effort
	}
}
