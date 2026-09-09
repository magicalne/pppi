package dev.pppi.omni

/**
 * Interactive-mode boot state machine — every second between "tap" and
 * "listening" has a name the pill can say out loud (PRD: talk to a person,
 * not a terminal). The button means stop/hang-up in every state; Failed
 * always offers retry on the button itself.
 */
sealed interface VoiceBootState {
	data object Idle : VoiceBootState
	data object Connecting : VoiceBootState
	/** Server is loading/warming its voice models; `detail` is the human reason. */
	data class Warming(val detail: String?) : VoiceBootState
	/** Headset routing (Bluetooth SCO) — only shown when it can take real time. */
	data object Routing : VoiceBootState
	data object Ready : VoiceBootState
	/** Mid-session drop; auto-reconnects twice before surfacing Failed. */
	data object Reconnecting : VoiceBootState
	data class Failed(val reason: String) : VoiceBootState

	val booting: Boolean
		get() = this is Connecting || this is Warming || this is Routing || this is Reconnecting
}
