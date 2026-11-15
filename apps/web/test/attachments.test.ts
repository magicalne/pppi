// #upload: attachment rendering tests — thumbnails with token-authenticated
// URLs, file chips for non-images, and the size formatter used on chips.

import type { Attachment } from "@pppi/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachmentChips, fileIconFor } from "../src/Attachments.tsx";

const img: Attachment = {
	path: "/home/u/.pppi/uploads/s1/1-shot.png",
	name: "shot.png",
	mime: "image/png",
	size: 1234,
	url: "/api/uploads/s1/1-shot.png",
};
const file: Attachment = {
	path: "/home/u/.pppi/uploads/s1/2-notes.txt",
	name: "notes.txt",
	mime: "text/plain",
	size: 4567,
	url: "/api/uploads/s1/2-notes.txt",
};

describe("AttachmentChips render (#upload)", () => {
	it("renders image attachments as thumbnails with token-authenticated urls", () => {
		const html = renderToStaticMarkup(createElement(AttachmentChips, { attachments: [img], token: "tok 1" }));
		// both the link and the img carry ?token= (img tags cannot send headers)
		expect(html).toContain('src="/api/uploads/s1/1-shot.png?token=tok%201"');
		expect(html).toContain('href="/api/uploads/s1/1-shot.png?token=tok%201"');
		expect(html).toContain('alt="shot.png"');
		// thumbnails open full-size in a new tab, not the LAN-less void
		expect(html).toContain('target="_blank"');
	});

	it("renders non-image attachments as name+size chips", () => {
		const html = renderToStaticMarkup(createElement(AttachmentChips, { attachments: [file], token: "t" }));
		expect(html).toContain("notes.txt");
		expect(html).toContain("4567");
		expect(html).not.toContain("<img");
	});

	it("keeps attachment order", () => {
		const html = renderToStaticMarkup(createElement(AttachmentChips, { attachments: [img, file], token: "t" }));
		expect(html.indexOf("shot.png")).toBeLessThan(html.indexOf("notes.txt"));
	});
});

describe("fileIconFor (#59 typed chips)", () => {
	it("images, pdfs, data files and everything else get distinct icons", () => {
		expect(fileIconFor("image/png")).toMatch(/\u{1F5BC}|\u{1F5BC}\uFE0F/u);
		expect(fileIconFor("application/pdf")).toBe("\u{1F4D5}");
		expect(fileIconFor("text/csv")).toBe("\u{1F4C4}");
		expect(fileIconFor("application/json")).toBe("\u{1F4C4}");
		expect(fileIconFor("application/xml")).toBe("\u{1F4C4}");
		expect(fileIconFor("text/x-log")).toBe("\u{1F4C1}");
	});
});
