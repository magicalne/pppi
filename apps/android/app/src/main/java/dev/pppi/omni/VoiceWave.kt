package dev.pppi.omni

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Live soundwave above the composer while interactive mode is on (PRD §7,
 * "talk to a person not a terminal"). A fixed-rate sampler keeps the trailing
 * window honest even when levels fire faster than recomposition — mic input
 * while listening, TTS output while the agent speaks — over a slow idle
 * ripple so the wave breathes through silence and thinking.
 */
@Composable
fun VoiceWave(theme: PppiTheme, inLevel: Int, outLevel: Int, phase: VoicePhase) {
	val barCount = 28
	val history = remember { IntArray(barCount) }
	var tick by remember { mutableIntStateOf(0) }
	val ripple = rememberInfiniteTransition(label = "wave")
	val sweep by ripple.animateFloat(
		0f,
		(2 * Math.PI).toFloat(),
		infiniteRepeatable(tween(2800, easing = LinearEasing)),
		label = "sweep",
	)
	val target = if (phase == VoicePhase.AGENT_SPEAKING) outLevel else inLevel
	val currentTarget by rememberUpdatedState(target)
	LaunchedEffect(Unit) {
		while (true) {
			for (i in barCount - 1 downTo 1) history[i] = history[i - 1]
			history[0] = currentTarget
			tick++
			delay(100)
		}
	}
	Canvas(
		Modifier
			.fillMaxWidth()
			.height(42.dp)
			.padding(horizontal = 18.dp),
	) {
		if (tick < 0) return@Canvas // state read: redraw when the window shifts
		val color = if (phase == VoicePhase.THINKING) theme.dim else theme.accent
		val slot = size.width / barCount
		for (i in 0 until barCount) {
			val level = history[i] / 100f
			val idle = 0.13f + 0.07f * sin(sweep + i * 0.55f)
			val h = size.height * max(idle, sqrt(level)).coerceIn(0f, 1f)
			drawRoundRect(
				color = color.copy(alpha = 0.4f + 0.6f * (h / size.height)),
				topLeft = Offset(i * slot + slot * 0.25f, (size.height - h) / 2f),
				size = Size(slot * 0.5f, h),
				cornerRadius = CornerRadius(slot * 0.25f),
			)
		}
	}
}
