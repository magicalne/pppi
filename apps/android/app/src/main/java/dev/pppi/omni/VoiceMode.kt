package dev.pppi.omni

// Voice mode (#53/#54): always-listen / push-to-talk / off. Persisted per
// device; OFF is the default starting with #54 (speech never records while
// off — the mic is only armed inside an explicit hold or a started session).

import android.content.Context

enum class VoiceMode { ALWAYS, PTT, OFF }

fun parseVoiceMode(raw: String?): VoiceMode = when (raw) {
	"always" -> VoiceMode.ALWAYS
	"ptt" -> VoiceMode.PTT
	// #53 keeps today's behavior as the default; #54 flips it to OFF
	else -> VoiceMode.ALWAYS
}

fun voiceModeLabel(mode: VoiceMode): String = when (mode) {
	VoiceMode.ALWAYS -> "Always listen"
	VoiceMode.PTT -> "Push to talk"
	VoiceMode.OFF -> "Off"
}

fun voiceModeHint(mode: VoiceMode): String = when (mode) {
	VoiceMode.ALWAYS -> "just talk — the mic listens while the session is live"
	VoiceMode.PTT -> "hold the mic to record · release sends"
	VoiceMode.OFF -> "voice off — hold the mic to talk anyway, or pick a mode"
}

object VoiceModeStore {
	private const val PREFS = "pppi"
	private const val KEY = "voiceMode"

	fun load(context: Context): VoiceMode =
		parseVoiceMode(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null))

	fun save(context: Context, mode: VoiceMode) {
		context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, mode.name.lowercase()).apply()
	}
}
