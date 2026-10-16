// Sessions-drawer coloring (#45) — the same identity reply attribution uses.
// Pure helpers so the drawer's color decisions are testable: profile dot
// colors, state modifiers that keep busy/idle/unreachable distinguishable,
// and section-header tints (color-mix keeps theme-token discipline).

/** Profile color for a session row; "" falls back to the theme accent in CSS.
 *  Hex-validated: profile files are user-written JSON — junk must not reach
 *  an inline style. */
export function sessionDotColor(profile: { color?: string } | undefined): string {
	const c = profile?.color ?? "";
	return /^#[0-9a-fA-F]{6}$/.test(c) ? c : "";
}

/** dot modifier for the session state: busy pulses, unreachable goes hollow
 *  (idle = solid dot). The textual state label stays as the secondary cue. */
export function dotStateClass(state: string): string {
	if (state === "busy" || state === "busy+queued") return "busy";
	if (state === "unreachable") return "unreach";
	return "";
}

/** Section header tint from the repo's main-session profile color:
 *  the label mixes toward the profile color, the rule wears it fully. */
export function sectionTint(color: string): { color: string; borderTopColor: string } {
	return {
		color: `color-mix(in oklab, var(--text) 78%, ${color})`,
		borderTopColor: color,
	};
}
