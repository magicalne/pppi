/**
 * Echo gate — issue #21. Half-duplex mic gating while the agent's own TTS
 * plays, because platform AEC alone leaks on speakerphone (the live repro).
 *
 * Policy (all times injectable; `now` defaults to Date.now):
 *  - speaking:  gated from the first TTS frame until playback drains
 *  - tail:      after natural drain, keep gating `tailMs` (default 400 ms)
 *               so speaker tail/reverb isn't heard as the user starting
 *  - interrupt: an explicit user cut (tap stop) still ends playback — gate
 *               only `interruptTailMs` (default 250 ms; output is already
 *               fading) so the user can speak again quickly
 *  - stall:     if "speaking" sees no audio chunk for `stallMs` (default
 *               2500 ms) the gate self-drains — a lost tts_end must never
 *               brick the microphone
 *
 * While gated the client stops SENDING mic audio (the server VAD/STT never
 * hears the agent); the explicit interrupt affordance stays functional
 * because it is a button, not speech.
 */

export type EchoGateState = "idle" | "speaking" | "tail";

export type EchoGateOpts = {
	tailMs?: number;
	interruptTailMs?: number;
	stallMs?: number;
	now?: () => number;
};

export class EchoGate {
	private speaking = false;
	private tailUntil = 0;
	private lastActivity = 0;
	private readonly tailMs: number;
	private readonly interruptTailMs: number;
	private readonly stallMs: number;
	private readonly now: () => number;

	constructor(opts: EchoGateOpts = {}) {
		this.tailMs = opts.tailMs ?? 400;
		this.interruptTailMs = opts.interruptTailMs ?? 250;
		this.stallMs = opts.stallMs ?? 2500;
		this.now = opts.now ?? Date.now;
	}

	/** TTS started (tts_start or the server's speaking state). Idempotent. */
	beginPlayback(): void {
		this.speaking = true;
		this.lastActivity = this.now();
	}

	/** Any TTS audio chunk — refreshes activity so the stall watchdog doesn't fire mid-reply. */
	feedChunk(): void {
		if (this.speaking) this.lastActivity = this.now();
	}

	/** Playback drained naturally (speaker empty) — hold the tail for reverb. */
	playbackDrained(): void {
		this.speaking = false;
		this.tailUntil = Math.max(this.tailUntil, this.now() + this.tailMs);
	}

	/** Explicit user interrupt — output is already fading, reopen the mic sooner. */
	interrupt(): void {
		this.speaking = false;
		const until = this.now() + this.interruptTailMs;
		// never EXTEND a close: mid-tail interrupts only ever open sooner
		this.tailUntil = this.tailUntil > this.now() ? Math.min(this.tailUntil, until) : until;
	}

	/** Session end / teardown — gate open immediately, unconditionally. */
	reset(): void {
		this.speaking = false;
		this.tailUntil = 0;
		this.lastActivity = 0;
	}

	get state(): EchoGateState {
		if (this.speaking) {
			// a lost tts_end must not mute the mic forever
			if (this.now() - this.lastActivity > this.stallMs) {
				this.speaking = false;
				this.tailUntil = Math.max(this.tailUntil, this.now() + this.tailMs);
			} else {
				return "speaking";
			}
		}
		return this.now() < this.tailUntil ? "tail" : "idle";
	}

	/** True while mic audio must NOT be sent to the server. */
	isGated(): boolean {
		return this.state !== "idle";
	}
}
