import type { Artifact } from "@pppi/protocol";
import { useState } from "react";

/**
 * Artifacts — issue #17, client side. A rich view arrives as part of an
 * assistant reply and renders as a tappable card; tapping opens the
 * full-screen sandboxed viewer.
 *
 * ── Sandbox policy (deliberate + documented; see docs/artifacts.md) ──
 *
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin` gives the iframe an
 * OPAQUE ORIGIN:
 *   - it cannot read this app's localStorage (the pairing token), cookies,
 *     or any parent DOM — isolation is structural, not filtering
 *   - no popups, no forms, no top-level navigation (not granted)
 * Scripts ARE allowed so interactive artifacts (later) work, but they run
 * inside that opaque origin. On top of that, a CSP meta is injected as the
 * very first thing in the srcdoc → ZERO network: no fetch/XHR/websockets, no
 * external images/fonts/scripts — only inline style/script and data: assets.
 * An artifact is therefore fully self-contained and cannot phone home (or
 * phone the LAN).
 */

export const ARTIFACT_SANDBOX = "allow-scripts";
export const ARTIFACT_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** srcdoc = CSP meta (first!) + the artifact's own document */
export function artifactSrcdoc(artifact: Artifact): string {
	return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">${artifact.content}`;
}

export function ArtifactCard({ artifact, onOpen }: { artifact: Artifact; onOpen: (a: Artifact) => void }) {
	const supported = artifact.kind === "html";
	return (
		<button
			type="button"
			className={`artifact-card ${supported ? "" : "unsupported"}`}
			disabled={!supported}
			onClick={() => supported && onOpen(artifact)}
		>
			<span className="artifact-glyph" aria-hidden>
				◫
			</span>
			<span className="artifact-meta">
				<span className="artifact-title">{artifact.title}</span>
				<span className="artifact-kind">
					{supported ? `${artifact.kind} view · tap to open` : `${artifact.kind} — not supported on this client yet`}
				</span>
			</span>
			{supported && (
				<span className="artifact-open" aria-hidden>
					→
				</span>
			)}
		</button>
	);
}

/** Full-screen artifact view: safe-area aware, theme aware, sandboxed iframe */
export function ArtifactView({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
	return (
		<div className="artifact-view" aria-label={artifact.title}>
			<header className="artifact-head">
				<button type="button" className="iconbtn" aria-label="Close artifact" onClick={onClose}>
					←
				</button>
				<span className="artifact-view-title">{artifact.title}</span>
			</header>
			<iframe
				title={artifact.title}
				sandbox={ARTIFACT_SANDBOX}
				referrerPolicy="no-referrer"
				srcDoc={artifactSrcdoc(artifact)}
			/>
		</div>
	);
}

/** one-artifact local state for hosts that render cards inline */
export function useArtifactViewer(): {
	viewer: React.ReactNode;
	open: (artifact: Artifact) => void;
} {
	const [artifact, setArtifact] = useState<Artifact | null>(null);
	return {
		viewer: artifact ? <ArtifactView artifact={artifact} onClose={() => setArtifact(null)} /> : null,
		open: setArtifact,
	};
}
