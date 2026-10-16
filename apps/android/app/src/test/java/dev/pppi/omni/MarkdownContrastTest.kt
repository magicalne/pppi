// Theme contrast tests (#35): the pairs the code chips rely on must have real
// contrast in EVERY theme. Android pins PppiThemes' text/surface (code-chip
// ink/bg after the fix) at >= 4.5:1 and dim/surface (the copy-button pair)
// at >= 3:1, per WCAG relative luminance.

package dev.pppi.omni

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import org.junit.Assert.assertTrue
import org.junit.Test

private fun channel(v: Double): Double = if (v <= 0.03928) v / 12.92 else Math.pow((v + 0.055) / 1.055, 2.4)

private fun luminance(c: Color): Double {
	val argb = c.toArgb()
	val r = ((argb shr 16) and 0xFF) / 255.0
	val g = ((argb shr 8) and 0xFF) / 255.0
	val b = (argb and 0xFF) / 255.0
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

private fun contrast(a: Color, b: Color): Double {
	val la = luminance(a)
	val lb = luminance(b)
	val hi = maxOf(la, lb)
	val lo = minOf(la, lb)
	return (hi + 0.05) / (lo + 0.05)
}

class MarkdownContrastTest {
	@Test
	fun codeChipInkOnSurfacePassesWCAGAAInEveryTheme() {
		for (theme in PppiThemes) {
			val ratio = contrast(theme.text, theme.surface)
			assertTrue(
				"${theme.name}: text ${theme.text} on surface ${theme.surface} is $ratio:1 (need >= 4.5)",
				ratio >= 4.5,
			)
		}
	}

	@Test
	fun copyButtonDimOnSurfaceStaysLegibleInEveryTheme() {
		for (theme in PppiThemes) {
			val ratio = contrast(theme.dim, theme.surface)
			assertTrue(
				"${theme.name}: dim ${theme.dim} on surface ${theme.surface} is $ratio:1 (need >= 3.0)",
				ratio >= 3.0,
			)
		}
	}

	@Test
	fun delegatedBubbleInkIsDarkNotThemeText() {
		// the delegated branch renders MarkdownBody(color = dark ink) — the bug
		// was code chips inheriting it on a surface background; the fix pins
		// codeColor to theme.text. Guard the invariant the fix relies on:
		// the hardcoded bubble ink exists and differs from every theme's text.
		val ink = Color(0xFF141210)
		for (theme in PppiThemes) {
			assertTrue("${theme.name}: ink should not equal theme text", ink != theme.text)
		}
	}
}
