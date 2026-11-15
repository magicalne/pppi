// #upload: attachments under a sent message — image thumbnails (tap to
// view full-size in a new tab) or name+size chips for other files.

import type { Attachment } from "@pppi/protocol";

/** #upload: attachments under a sent message — image thumbnails (tap to
 *  view full-size in a new tab) or name+size chips for other files */
/** chip icon by mime: images and pdfs get distinct glyphs, docs share one */
export function fileIconFor(mime: string): string {
	if (mime.startsWith("image/")) return "\u{1F5BC}\uFE0F";
	if (mime === "application/pdf") return "\u{1F4D5}";
	if (mime === "text/csv" || mime === "application/json" || mime === "application/xml") return "\u{1F4C4}";
	return "\u{1F4C1}";
}

export function AttachmentChips({ attachments, token }: { attachments: Attachment[]; token: string }) {
	return (
		<div className="msg-attachments">
			{attachments.map((a) =>
				a.mime.startsWith("image/") ? (
					<a
						key={a.path}
						href={`${a.url}?token=${encodeURIComponent(token)}`}
						target="_blank"
						rel="noopener noreferrer"
					>
						<img className="msg-attachment-img" src={`${a.url}?token=${encodeURIComponent(token)}`} alt={a.name} />
					</a>
				) : (
					<span key={a.path} className="msg-attachment-file">
						{fileIconFor(a.mime)} {a.name} · {a.size}
					</span>
				),
			)}
		</div>
	);
}
