// Markdown rendering + copy affordances for the Android client (#35).
//
// Renders the AST from Markdown.kt (a port of the web client's #16 renderer)
// with Compose primitives. XSS-safe by construction: text only ever flows
// into Text/AnnotatedString (always escaped — no HTML string exists), and
// links are click handlers over safeHref-vetted http/https/mailto URLs that
// launch the platform viewer via ACTION_VIEW; javascript:/data: never become
// links in the first place.
//
// Copy (#12 parity): message text is selectable everywhere (SelectionContainer),
// every message gets a one-tap full-message copy affordance (plain-text
// projection — Markdown.messageToPlainText), and code blocks have their own
// raw-code copy button.

package dev.pppi.omni

import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow

/** opens a vetted URL in the platform viewer (browser / mailto) */
private fun openUrl(context: android.content.Context, href: String) {
	try {
		context.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(href)))
	} catch (_: Exception) {
		Toast.makeText(context, "no handler for $href", Toast.LENGTH_SHORT).show()
	}
}

// ---------------------------------------------------------------- inline

private fun appendInline(
	sb: AnnotatedString.Builder,
	nodes: List<MdInline>,
	base: TextStyle,
	theme: PppiTheme,
	onLink: (String) -> Unit,
) {
	for (n in nodes) {
		when (n) {
			is MdInline.Text -> sb.append(n.s)
			is MdInline.Code ->
				sb.withStyle(
					SpanStyle(
						fontFamily = FontFamily.Monospace,
						fontSize = base.fontSize * 0.88f,
						background = theme.surface,
					),
				) { sb.append(n.s) }
			is MdInline.Strong -> sb.withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) {
				appendInline(sb, n.c, base, theme, onLink)
			}
			is MdInline.Em -> sb.withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
				appendInline(sb, n.c, base, theme, onLink)
			}
			is MdInline.Link -> {
				val tag = "md-link"
				sb.withLink(
					LinkAnnotation.Clickable(tag = tag, styles = TextLinkStyles(SpanStyle(color = theme.accent, textDecoration = TextDecoration.Underline))) { onLink(n.href) },
				) {
					appendInline(sb, n.c, base, theme, onLink)
				}
			}
		}
	}
}

@Composable
private fun MdText(nodes: List<MdInline>, base: TextStyle, theme: PppiTheme) {
	val context = LocalContext.current
	Text(
		text = buildAnnotatedString { appendInline(this, nodes, base, theme) { openUrl(context, it) } },
		style = base,
		modifier = Modifier.fillMaxWidth(),
	)
}

// ---------------------------------------------------------------- blocks

private val BLOCK_GAP = 10.dp

@Composable
private fun MdBlockView(b: MdBlock, base: TextStyle, theme: PppiTheme) {
	when (b) {
		is MdBlock.Para -> MdText(b.c, base, theme)

		is MdBlock.Heading -> {
			val scale = when {
				b.level <= 1 -> 1.22f
				b.level == 2 -> 1.12f
				else -> 1.05f
			}
			MdText(
				b.c,
				base.copy(
					fontSize = (base.fontSize.value * scale).sp,
					fontWeight = FontWeight.SemiBold,
					lineHeight = (base.lineHeight.value * scale).sp,
				),
				theme,
			)
		}

		is MdBlock.Code ->
			if (b.lang.startsWith("pppi-artifact")) {
				// an artifact fence arriving via deltas (#17): show a building
				// card, not the raw HTML — the real card lands on assistant_final
				MdPendingArtifact(theme)
			} else {
				MdCodeBlock(b.s, theme)
			}

		is MdBlock.Hr -> Box(
			Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(theme.line),
		)

		is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
			Box(Modifier.width(3.dp).fillMaxHeight().background(theme.dim.copy(alpha = 0.5f)))
			Spacer(Modifier.width(10.dp))
			Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(BLOCK_GAP)) {
				b.c.forEach { MdBlockView(it, base.copy(color = theme.dim), theme) }
			}
		}

		is MdBlock.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
			b.items.forEachIndexed { i, item ->
				Row {
					Text(
						if (b.ordered) "${b.start + i}." else "•",
						style = base.copy(color = theme.dim),
						modifier = Modifier.width(if (b.ordered) 26.dp else 16.dp),
					)
					Column(Modifier.weight(1f)) {
						MdText(item, base, theme)
					}
				}
			}
		}

		is MdBlock.Table -> Column(Modifier.width(IntrinsicSize.Max)) {
			Row(Modifier.fillMaxWidth().background(theme.surface)) {
				b.head.forEachIndexed { c, cell ->
					Box(
						Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 6.dp),
						contentAlignment = alignOf(b.align, c),
					) {
						MdText(cell, base.copy(fontWeight = FontWeight.SemiBold, fontSize = base.fontSize * 0.92f), theme)
					}
				}
			}
			Box(Modifier.fillMaxWidth().height(1.dp).background(theme.line))
			b.rows.forEach { row ->
				Row(Modifier.fillMaxWidth()) {
					row.forEachIndexed { c, cell ->
						Box(
							Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 6.dp),
							contentAlignment = alignOf(b.align, c),
						) {
							MdText(cell, base.copy(fontSize = base.fontSize * 0.92f), theme)
						}
					}
				}
			}
		}
	}
}

private fun alignOf(align: List<String?>, col: Int): Alignment = when (align.getOrNull(col)) {
	"center" -> Alignment.TopCenter
	"right" -> Alignment.TopEnd
	else -> Alignment.TopStart
}

/** building-artifact placeholder (parity with the web's pending card) */
@Composable
private fun MdPendingArtifact(theme: PppiTheme) {
	Row(
		Modifier
			.fillMaxWidth()
			.clip(RoundedCornerShape(10.dp))
			.background(theme.surface)
			.border(1.dp, theme.line, RoundedCornerShape(10.dp))
			.padding(horizontal = 12.dp, vertical = 10.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Text("◫", color = theme.accent, fontSize = 20.sp)
		Spacer(Modifier.width(10.dp))
		Column {
			Text("building artifact…", color = theme.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
			Text("the view lands when the reply finishes", color = theme.dim, fontSize = 12.sp)
		}
	}
}

/** fenced code: mono, horizontally scrollable, with a raw-code copy button */
@Composable
fun MdCodeBlock(code: String, theme: PppiTheme) {
	// 0 = idle, 1 = copied, 2 = failed
	var flash by remember { mutableIntStateOf(0) }
	val clipboard = LocalClipboardManager.current
	LaunchedEffect(flash) {
		if (flash != 0) {
			delay(1400)
			flash = 0
		}
	}
	Row(
		Modifier
			.fillMaxWidth()
			.clip(RoundedCornerShape(8.dp))
			.background(theme.surface)
			.border(1.dp, theme.line, RoundedCornerShape(8.dp))
			.padding(start = 10.dp, top = 8.dp, bottom = 8.dp, end = 6.dp),
		verticalAlignment = Alignment.Top,
	) {
		Text(
			code,
			fontFamily = FontFamily.Monospace,
			fontSize = 13.sp,
			lineHeight = 18.sp,
			color = theme.text,
			softWrap = false,
			overflow = TextOverflow.Visible,
			modifier = Modifier.weight(1f).horizontalScroll(rememberScrollState()),
		)
		Text(
			if (flash == 1) "✓" else if (flash == 2) "✕" else "⧉",
			color = if (flash == 1) theme.accent else if (flash == 2) theme.danger else theme.dim,
			fontSize = 15.sp,
			modifier = Modifier
				.clip(RoundedCornerShape(6.dp))
				.clickable {
					clipboard.setText(AnnotatedString(code))
					flash = 1
				}
				.padding(horizontal = 8.dp, vertical = 4.dp),
		)
	}
}

// ---------------------------------------------------------------- body

/** The message body renderer: markdown AST -> Compose. Wrap in
 *  SelectionContainer at the call site to make it selectable. */
@Composable
fun MarkdownBody(
	text: String,
	theme: PppiTheme,
	color: Color = theme.text,
	fontSize: TextUnit = 17.sp,
	lineHeight: TextUnit = 26.sp,
) {
	val blocks = remember(text) { Markdown.parseBlocks(text) }
	if (blocks.isEmpty()) return
	val base = TextStyle(color = color, fontSize = fontSize, lineHeight = lineHeight)
	Column(verticalArrangement = Arrangement.spacedBy(BLOCK_GAP)) {
		blocks.forEach { MdBlockView(it, base, theme) }
	}
}

/** one-tap full-message copy — plain text for markdown bodies (#12 parity) */
@Composable
fun MsgCopyAffordance(text: String, theme: PppiTheme, alignEnd: Boolean = true) {
	var state by remember { mutableIntStateOf(0) } // 0 idle, 1 ok, 2 fail
	val clipboard = LocalClipboardManager.current
	LaunchedEffect(state) {
		if (state != 0) {
			delay(1400)
			state = 0
		}
	}
	Row(
		Modifier.fillMaxWidth(),
		horizontalArrangement = if (alignEnd) Arrangement.End else Arrangement.Start,
	) {
		Text(
			when (state) {
				1 -> "copied ✓"
				2 -> "copy failed — select manually"
				else -> "⧉ copy"
			},
			color = theme.dim,
			fontSize = 11.sp,
			maxLines = 1,
			modifier = Modifier
				.clip(RoundedCornerShape(6.dp))
				.clickable {
					try {
						clipboard.setText(AnnotatedString(Markdown.messageToPlainText(text)))
						state = 1
					} catch (_: Exception) {
						state = 2
					}
				}
				.padding(horizontal = 6.dp, vertical = 3.dp),
		)
	}
}
