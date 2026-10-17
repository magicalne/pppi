// #upload: attachments under a sent message — image thumbnails (tap to
// view full-size in a new tab) or name+size chips for other files.

import type { Attachment } from "@pppi/protocol";

/** #upload: attachments under a sent message — image thumbnails (tap to
 *  view full-size in a new tab) or name+size chips for other files */
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
						{a.name} · {a.size}
					</span>
				),
			)}
		</div>
	);
}
