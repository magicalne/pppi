package dev.pppi.omni

/**
 * Echo gate — Android port of apps/web/src/voice/echoGate.ts (#21 parity,
 * user-reported on v0.3.0: speakerphone leaked the agent's own TTS into STT).
 *
 * Policy (times injectable; `now` defaults to the monotonic clock):
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
 * hears the agent); mic levels keep flowing for the waveform, and the
 * explicit interrupt affordance stays functional (it is a button, not
 * speech). Keep this byte-for-byte behaviorally identical to the TS class —
 * EchoGateTest.kt mirrors apps/web/test/echoGate.test.ts case for case.
 */
class EchoGate(
	private val tailMs: Long = 400,
	private val interruptTailMs: Long = 250,
	private val stallMs: Long = 2500,
	private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() },
) {
	private var speaking = false
	private var tailUntil = 0L
	private var lastActivity = 0L

	/** TTS started (tts_start or the server's speaking state). Idempotent. */
	fun beginPlayback() {
		speaking = true
		lastActivity = now()
	}

	/** Any TTS audio chunk — refreshes activity so the stall watchdog doesn't fire mid-reply. */
	fun feedChunk() {
		if (speaking) lastActivity = now()
	}

	/** Playback drained naturally (speaker empty) — hold the tail for reverb. */
	fun playbackDrained() {
		speaking = false
		tailUntil = maxOf(tailUntil, now() + tailMs)
	}

	/** Explicit user interrupt — output is already fading, reopen the mic sooner. */
	fun interrupt() {
		speaking = false
		val until = now() + interruptTailMs
		// never EXTEND a close: mid-tail interrupts only ever open sooner
		tailUntil = if (tailUntil > now()) minOf(tailUntil, until) else until
	}

	/** Session end / teardown — gate open immediately, unconditionally. */
	fun reset() {
		speaking = false
		tailUntil = 0
		lastActivity = 0
	}

	val state: String // "idle" | "speaking" | "tail"
		get() {
			if (speaking) {
				// a lost tts_end must not mute the mic forever
				if (now() - lastActivity > stallMs) {
					speaking = false
					tailUntil = maxOf(tailUntil, now() + tailMs)
				} else {
					return "speaking"
				}
			}
			return if (now() < tailUntil) "tail" else "idle"
		}

	/** True while mic audio must NOT be sent to the server. */
	fun isGated(): Boolean = state != "idle"
}
