/**
 * Clipboard write with an Android-LAN fallback — issue #12.
 *
 * navigator.clipboard only exists in SECURE contexts (https, localhost). The
 * phone client is typically served over plain http from the gateway on the
 * LAN, where Android Chrome exposes no async clipboard API at all — so we try
 * it first (it's the clean path on https/PWA installs) and fall back to the
 * execCommand+textarea dance, which still works there. Both paths are
 * injectable for tests; with neither available (SSR/node) we report false.
 */

export type CopyDeps = {
	/** resolves like navigator.clipboard.writeText; omit/throw → fallback */
	writeText?: (text: string) => Promise<void>;
	/** resolves like the execCommand path; omit → none available */
	execCopy?: (text: string) => boolean;
};

function defaultWriteText(): ((text: string) => Promise<void>) | undefined {
	if (typeof navigator === "undefined") return undefined;
	const clip = (navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } }).clipboard;
	return clip?.writeText?.bind(clip);
}

function defaultExecCopy(): ((text: string) => boolean) | undefined {
	if (typeof document === "undefined" || typeof document.execCommand !== "function") return undefined;
	return (text: string) => {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		// off-screen but focusable/selectable — never display:none
		ta.style.position = "fixed";
		ta.style.top = "-1000px";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		const sel = document.getSelection();
		const prevRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
		ta.focus();
		ta.select();
		ta.setSelectionRange(0, text.length);
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} finally {
			ta.remove();
			if (prevRange && sel) {
				sel.removeAllRanges();
				sel.addRange(prevRange); // don't eat an in-progress user selection
			}
		}
		return ok;
	};
}

/** Copy `text`; true when some path succeeded. Never throws. */
export async function copyTextToClipboard(text: string, deps: CopyDeps = {}): Promise<boolean> {
	const writeText = deps.writeText ?? defaultWriteText();
	if (writeText) {
		try {
			await writeText(text);
			return true;
		} catch {
			// permission denied / document not focused → try the legacy path
		}
	}
	const execCopy = deps.execCopy ?? defaultExecCopy();
	if (execCopy) {
		try {
			return execCopy(text);
		} catch {
			return false;
		}
	}
	return false;
}
