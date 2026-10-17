// Brain-button decisions (#48) — pure and testable: when the brain is
// enabled/disabled (and why), and what a TAP cycles to. The status bar wires
// these into its press-hold-swipe slider + tap affordance.

import type { AgentStatus, ModelInfo } from "@pppi/protocol";

/** pi's canonical thinking ladder (pi-agent-core ThinkingLevel), in order. */
export const LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The brain is dead only when NOTHING says the model thinks: not the
 * `reasoning` flag, not a multi-stop levels list, and not a populated
 * thinkingLevelMap. Maps count (#48): levels can under-report (RPC failure
 * or ["off"] only) while the map still carries pi's truth.
 */
export function brainDead(model: ModelInfo | null, thinkingLevels: string[]): boolean {
	if (!model) return true;
	if (model.reasoning) return false;
	if (thinkingLevels.length > 1) return false;
	return Object.keys(model.thinkingLevelMap ?? {}).length <= 1;
}

/** Why a disabled brain's tap explains itself with. */
export function disabledReason(model: ModelInfo | null, active: boolean, targetLabel: string): string | null {
	if (active) return model ? `${model.name} doesn't do thinking` : "no model yet";
	return `switch model in ${targetLabel} itself`;
}

/**
 * What a plain TAP cycles to: the next stop in order, wrapping max → off.
 * null when there is nothing to cycle (single stop) — callers no-op.
 */
export function nextTapLevel(stops: string[], level: string): string | null {
	if (stops.length < 2) return null;
	const idx = stops.indexOf(level);
	if (idx === -1) return stops[0] ?? null;
	return stops[(idx + 1) % stops.length] ?? null;
}
