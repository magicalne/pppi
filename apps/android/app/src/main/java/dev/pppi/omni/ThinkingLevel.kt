package dev.pppi.omni

import java.util.Locale

// Status-bar thinking helpers — mirrors apps/web/src/status/StatusBar.tsx.

/** pi's canonical thinking ladder (pi-agent-core ThinkingLevel). */
val THINKING_LADDER = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")

/** Brightness of the brain per level — dim at off, fully lit at max. */
fun brainAlpha(level: String): Float = when (level) {
	"off" -> 0f
	"minimal" -> 0.25f
	"low" -> 0.4f
	"medium" -> 0.55f
	"high" -> 0.7f
	"xhigh" -> 0.85f
	"max" -> 1f
	else -> 0f
}

fun formatTokens(n: Long?): String {
	if (n == null) return "—"
	return when {
		n < 1000 -> n.toString()
		n < 1_000_000 -> {
			val k = n / 1000.0
			val s = if (n < 100_000) String.format(Locale.US, "%.1f", k) else k.toInt().toString()
			"${s}k"
		}
		else -> {
			val m = n / 1_000_000.0
			val s = if (m >= 10 || m % 1.0 == 0.0) m.toInt().toString() else String.format(Locale.US, "%.1f", m)
			"${s}m"
		}
	}
}

/** "used/total (used%)"; "—" when unknown (peer target or post-compaction). */
fun formatContext(tokens: Long?, contextWindow: Long, percent: Double?): String {
	if (contextWindow <= 0L) return "—"
	val used = if (tokens == null) "—" else formatTokens(tokens)
	val pct = if (percent == null) "—" else percent.toInt().toString()
	return "$used/${formatTokens(contextWindow)} ($pct%)"
}

/** Canonical level + native value when pi's map differs (e.g. "off · none" on OpenAI). */
fun thinkingChipText(level: String, map: Map<String, String?>): String {
	val native = map[level]
	return if (native != null && native != level) "$level · $native" else level
}
