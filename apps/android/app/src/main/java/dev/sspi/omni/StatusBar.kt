package dev.sspi.omni

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.view.HapticFeedbackConstants
import kotlin.math.roundToInt

// Status bar (docs/plan/status-bar.md): context usage, model, thinking effort.
// The brain is a press-hold + swipe slider whose brightness IS the level; the
// model name opens the enabled-models bottom sheet. Parity with the web bar.

private val TICK_LABEL = mapOf("minimal" to "min", "medium" to "med")

/** One brain hemisphere in 24-unit space; drawn twice (right one mirrored). */
private fun lobePath(size: Float): Path = Path().apply {
	fun f(v: Float) = v * size / 24f
	moveTo(f(11.4f), f(20.9f))
	cubicTo(f(9f), f(20.9f), f(7f), f(19.2f), f(6.6f), f(16.9f))
	cubicTo(f(4.9f), f(15.8f), f(4f), f(13.8f), f(4.3f), f(11.7f))
	cubicTo(f(4.6f), f(9.6f), f(4.7f), f(7.4f), f(5.6f), f(5.9f))
	cubicTo(f(6.5f), f(4.4f), f(9.5f), f(3.8f), f(11.4f), f(4.6f))
	close()
}

@Composable
private fun BrainGlyph(level: String, theme: SspiTheme) {
	val alpha = brainAlpha(level)
	Canvas(Modifier.size(20.dp)) {
		val stroke = Stroke(width = 1.3.dp.toPx(), join = StrokeJoin.Round)
		val lobe = lobePath(this.size.width)
		drawPath(lobe, color = theme.dim, style = stroke)
		if (alpha > 0f) drawPath(lobe, color = theme.accent.copy(alpha = alpha))
		withTransform({ scale(-1f, 1f, pivot = center) }) {
			drawPath(lobe, color = theme.dim, style = stroke)
			if (alpha > 0f) drawPath(lobe, color = theme.accent.copy(alpha = alpha))
		}
	}
}

@Composable
fun StatusBarRow(
	theme: SspiTheme,
	status: AgentStatusDto?,
	active: Boolean,
	targetLabel: String,
	onSetThinking: (String) -> Unit,
	onOpenModels: () -> Unit,
) {
	val stops = status?.thinkingLevels ?: emptyList()
	val level = status?.thinkingLevel ?: "off"
	val curIdx = stops.indexOf(level).coerceAtLeast(0)
	val model = status?.model
	val noThinking = model == null || (!model.reasoning && stops.size <= 1)
	val enabled = active && !noThinking && stops.size > 1

	var drag by remember { mutableStateOf<Int?>(null) }
	var linger by remember { mutableStateOf<String?>(null) }
	LaunchedEffect(linger) {
		if (linger != null) {
			kotlinx.coroutines.delay(1200)
			linger = null
		}
	}

	// live reads for the gesture coroutine (recompositions don't restart it mid-drag)
	val curIdxState = rememberUpdatedState(curIdx)
	val stopsState = rememberUpdatedState(stops)
	val mapState = rememberUpdatedState(model?.thinkingLevelMap ?: emptyMap())
	val view = LocalView.current
	var brainOriginX by remember { mutableFloatStateOf(0f) }
	var slotOriginX by remember { mutableFloatStateOf(0f) }
	var slotWidthPx by remember { mutableFloatStateOf(0f) }
	var chipWidthPx by remember { mutableIntStateOf(0) }

	val shownIdx = drag ?: curIdx
	val ctx = status?.context
	val ctxText = if (!active) "—" else ctx?.let { formatContext(it.tokens, it.contextWindow, it.percent) } ?: "—"
	val ctxHot = active && (ctx?.percent ?: 0.0) >= 85.0
	val frac = if (stops.size > 1) shownIdx.toFloat() / (stops.size - 1) else 0f
	val chip = drag?.let { thinkingChipText(stops.getOrNull(it) ?: level, model?.thinkingLevelMap ?: emptyMap()) } ?: linger

	Row(
		Modifier
			.fillMaxWidth()
			.background(theme.bg)
			.heightIn(min = 36.dp)
			.padding(horizontal = 16.dp, vertical = 4.dp),
	 verticalAlignment = Alignment.CenterVertically,
	) {
		Box(
			Modifier
				.size(36.dp)
				.onGloballyPositioned { brainOriginX = it.positionInRoot().x }
				.then(
					if (enabled) {
						Modifier.pointerInput(stops) {
							awaitEachGesture {
								awaitFirstDown()
								var idx = curIdxState.value
								drag = idx
								while (true) {
									val event = awaitPointerEvent()
									val change = event.changes.firstOrNull() ?: break
									if (change.changedToUp()) {
										change.consume()
										break
									}
									val xInSlot = brainOriginX + change.position.x - slotOriginX
									val f = (xInSlot / slotWidthPx.coerceAtLeast(1f)).coerceIn(0f, 1f)
									val s = stopsState.value
									val next = (f * (s.size - 1)).roundToInt().coerceIn(0, s.size - 1)
									if (next != idx) {
										idx = next
										drag = idx
										view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
									}
								}
								// release commits; a plain tap (no stop change) commits nothing
								val final = idx
								drag = null
								if (final != curIdxState.value) {
									stopsState.value.getOrNull(final)?.let { lvl ->
										onSetThinking(lvl)
										linger = thinkingChipText(lvl, mapState.value)
									}
								}
							}
						}
					} else {
						Modifier
					},
				)
				.semantics {
					contentDescription = if (enabled) {
						"thinking effort: ${stops.getOrNull(curIdx) ?: level}"
					} else {
						"thinking effort unavailable"
					}
				},
		 contentAlignment = Alignment.Center,
		) {
			BrainGlyph(level = stops.getOrNull(shownIdx) ?: level, theme)
		}
		Spacer(Modifier.width(8.dp))

		Box(
			Modifier
				.weight(1f)
				.height(34.dp)
				.onGloballyPositioned {
					slotOriginX = it.positionInRoot().x
					slotWidthPx = it.size.width.toFloat()
				},
		) {
			if (drag != null && stops.size > 1) {
				// the slider takes the context text's place while held
				Box(Modifier.fillMaxSize()) {
					Box(
						Modifier
							.align(Alignment.CenterStart)
							.fillMaxWidth()
							.height(2.dp)
							.background(theme.line),
					)
					Box(
						Modifier
							.align(Alignment.CenterStart)
							.fillMaxWidth(frac)
							.height(2.dp)
							.background(theme.accent),
					)
					Box(
						Modifier
							.align(Alignment.CenterStart)
							.offset { IntOffset(((frac * slotWidthPx).toInt()) - 6, 0) }
							.size(12.dp)
							.clip(RoundedCornerShape(50))
							.background(theme.accent),
					)
					Row(
						Modifier.align(Alignment.BottomStart).fillMaxWidth(),
						horizontalArrangement = Arrangement.SpaceBetween,
					) {
						for (s in stops) {
							Text(
								TICK_LABEL[s] ?: s,
								color = if (THINKING_LADDER.indexOf(s) <= THINKING_LADDER.indexOf(stops.getOrNull(shownIdx) ?: "off")) {
									theme.accent
								} else {
									theme.dim
								},
								fontSize = 10.sp,
							)
						}
					}
					if (chip != null) {
						Text(
							chip,
							color = theme.text,
							fontSize = 11.sp,
							modifier = Modifier
								.align(Alignment.TopStart)
								.offset {
									val x = (frac.coerceIn(0.12f, 0.88f) * slotWidthPx).toInt() - chipWidthPx / 2
									IntOffset(x, 0)
								}
								.onGloballyPositioned { chipWidthPx = it.size.width }
								.clip(RoundedCornerShape(8.dp))
								.background(theme.surface)
								.border(1.dp, theme.line, RoundedCornerShape(8.dp))
								.padding(horizontal = 8.dp, vertical = 2.dp),
						)
					}
				}
			} else {
				Text(
					ctxText,
					color = if (ctxHot) theme.danger else theme.dim,
					fontSize = 12.5.sp,
					maxLines = 1,
				)
			}
		}

		Row(
			Modifier
				.clickable(enabled = active) { onOpenModels() }
				.padding(vertical = 8.dp, horizontal = 2.dp),
		 verticalAlignment = Alignment.CenterVertically,
		) {
			Text(
				if (active) (model?.name ?: "—") else targetLabel,
				color = if (active) theme.text else theme.dim,
				fontSize = 13.sp,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
				modifier = Modifier.widthIn(max = 160.dp),
			)
			if (active) {
				Spacer(Modifier.width(4.dp))
				Text("›", color = theme.dim, fontSize = 13.sp)
			}
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelSheet(
	theme: SspiTheme,
	models: List<ModelInfoDto>,
	current: ModelInfoDto?,
	onPick: (ModelInfoDto) -> Unit,
	onDismiss: () -> Unit,
) {
	ModalBottomSheet(onDismissRequest = onDismiss, containerColor = theme.surface) {
		Text(
			"Model",
			color = theme.text,
			fontSize = 16.sp,
			fontWeight = FontWeight.SemiBold,
			modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
		)
		if (models.isEmpty()) {
			Text(
				"no enabled models available",
				color = theme.dim,
				fontSize = 13.sp,
				modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
			)
		}
		for (m in models) {
			val isCurrent = current?.provider == m.provider && current?.id == m.id
			Row(
				Modifier
					.fillMaxWidth()
					.clickable { onPick(m) }
					.padding(horizontal = 16.dp, vertical = 10.dp),
			 verticalAlignment = Alignment.CenterVertically,
			) {
				Text(if (isCurrent) "✓" else "", color = theme.accent, fontSize = 15.sp, modifier = Modifier.width(20.dp))
				Text(
					m.name,
					color = if (isCurrent) theme.accent else theme.text,
					fontSize = 15.sp,
					fontWeight = if (isCurrent) FontWeight.SemiBold else FontWeight.Normal,
					maxLines = 1,
					overflow = TextOverflow.Ellipsis,
					modifier = Modifier.weight(1f),
				)
				Spacer(Modifier.width(8.dp))
				Text("${m.provider} · ${formatTokens(m.contextWindow)}", color = theme.dim, fontSize = 12.sp)
			}
		}
		Text(
			"from your pi enabled models",
			color = theme.dim,
			fontSize = 12.sp,
			modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
		)
	}
}
