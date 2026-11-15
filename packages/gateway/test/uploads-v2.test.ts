// Uploads v2 (#59): allowlist classification, the attachment history log
// (the #50 v1 gap), and the text-preview delivery semantics.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, ChatEntry } from "@pppi/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAttachments, resetAttachmentLogForTest, withHistoryAttachments } from "../src/attachment-log.ts";
import { UPLOAD_DOC_TYPES, UPLOAD_MAX_BYTES, classifyUpload } from "../src/gateway.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

describe("classifyUpload (allowlist, #59)", () => {
	it("accepts images by magic bytes regardless of name", () => {
		expect(classifyUpload(PNG, "photo.bin")).toMatchObject({ mime: "image/png", kind: "image" });
	});
	it("accepts pdf with the %PDF magic", () => {
		expect(classifyUpload(Buffer.from("%PDF-1.7 rest"), "spec.pdf")).toMatchObject({
			mime: "application/pdf",
			kind: "document",
			preview: false,
		});
	});
	it("rejects pdf-named files without the magic", () => {
		expect(classifyUpload(Buffer.from("definitely not a pdf"), "evil.pdf")).toBeNull();
	});
	it("accepts each allowlisted text type with preview=true", () => {
		for (const ext of ["txt", "md", "csv", "json", "xml", "yaml", "yml", "log"]) {
			const res = classifyUpload(Buffer.from("hello"), `file.${ext}`);
			expect(res, ext).toMatchObject({ kind: "document", preview: true });
		}
		expect(Object.keys(UPLOAD_DOC_TYPES)).toContain("pdf");
	});
	it("rejects everything else with null", () => {
		expect(classifyUpload(Buffer.from("MZ fake exe"), "tool.exe")).toBeNull();
		expect(classifyUpload(Buffer.from("hi"), "archive.zip")).toBeNull();
		expect(classifyUpload(Buffer.from("hi"), "noext")).toBeNull();
	});
	it("the cap is 20MB", () => {
		expect(UPLOAD_MAX_BYTES).toBe(20 * 1024 * 1024);
	});
});

describe("attachment history log (#50 v1 gap closed)", () => {
	let dir: string;
	const att: Attachment = {
		path: "/uploads/s/1-shot.png",
		name: "shot.png",
		mime: "image/png",
		size: 10,
		url: "/api/uploads/s/1-shot.png",
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pppi-attlog-"));
		process.env.PPPI_DIR = dir;
		resetAttachmentLogForTest();
	});
	afterAll(() => {
		delete process.env.PPPI_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	it("user entries matching ts+text get their attachments back on reload", () => {
		const ts = Date.now();
		recordAttachments(ts, "what is this screenshot?", [att]);
		const entry: ChatEntry = { id: "x", role: "user", text: "what is this screenshot?", ts };
		expect(withHistoryAttachments(entry)).toMatchObject({ attachments: [att] });
		// assistant entries never gain attachments
		const reply: ChatEntry = { id: "y", role: "assistant", text: "it is a cat", ts };
		expect(withHistoryAttachments(reply).attachments ?? []).toHaveLength(0);
	});

	it("entries outside the ts window or with different text stay untouched", () => {
		const ts = Date.now();
		recordAttachments(ts, "unique question A", [att]);
		expect(
			withHistoryAttachments({ id: "z", role: "user", text: "totally different", ts: ts + 60_000 }).attachments ?? [],
		).toHaveLength(0);
		expect(
			withHistoryAttachments({ id: "z2", role: "user", text: "different text same time", ts }).attachments ?? [],
		).toHaveLength(0);
	});

	it("empty-text messages still match within the window (chips-only sends)", () => {
		const ts = Date.now();
		recordAttachments(ts, "", [att]);
		expect(withHistoryAttachments({ id: "e", role: "user", text: "", ts })).toMatchObject({ attachments: [att] });
	});
});
