import type { AgentState } from "@pppi/protocol";

/**
 * Background-reply notification policy — #13. A delegated reply that lands
 * while no omni turn is active deserves the user's attention; one landing
 * mid-turn is carried by the conversation itself (no extra nudge).
 */

/** States in which a turn is active — a peer report would talk over it. */
const BUSY_STATES: ReadonlySet<AgentState> = new Set(["thinking", "tool", "streaming", "compacting"]);

export function shouldPeerReport(state: AgentState): boolean {
	return !BUSY_STATES.has(state);
}

/** first non-empty line of the reply, trimmed and capped; null if none */
export function reportPreview(reply: string, max = 90): string | null {
	const line = reply
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return line ? line.slice(0, max) : null;
}
