package dev.pppi.omni

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Appearance page (PRD §8): five themes as live mini chat previews. */
@Composable
fun ThemesPage(theme: PppiTheme, setTheme: (String) -> Unit, onBack: () -> Unit) {
	Column(
		Modifier
			.fillMaxSize()
			.background(theme.bg)
			.windowInsetsPadding(WindowInsets.safeDrawing)
			.padding(16.dp),
	) {
		Row(verticalAlignment = Alignment.CenterVertically) {
			Text(
				"←",
				color = theme.text,
				fontSize = 20.sp,
				modifier = Modifier
					.clickable { onBack() }
					.padding(4.dp),
			)
			Spacer(Modifier.width(10.dp))
			Text("Appearance", color = theme.text, fontSize = 20.sp)
		}
		Text(
			"Pick the mood. Applies instantly on every screen.",
			color = theme.dim,
			fontSize = 13.5.sp,
			modifier = Modifier.padding(top = 4.dp, bottom = 16.dp),
		)
		for (row in PppiThemes.chunked(2)) {
			Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
				for (t in row) {
					ThemeCard(t, theme.id == t.id, Modifier.weight(1f)) { setTheme(t.id) }
				}
				if (row.size == 1) Spacer(Modifier.weight(1f))
			}
			Spacer(Modifier.height(12.dp))
		}
	}
}

@Composable
private fun ThemeCard(t: PppiTheme, current: Boolean, modifier: Modifier, onClick: () -> Unit) {
	Column(
		modifier
			.clip(RoundedCornerShape(18.dp))
			.border(2.dp, if (current) t.accent else t.line, RoundedCornerShape(18.dp))
			.clickable { onClick() },
	) {
		Column(Modifier.fillMaxWidth().background(t.bg).padding(12.dp)) {
			Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
				Text(
					"is the build green?",
					color = t.userBubbleInk,
					fontSize = 11.sp,
					modifier = Modifier
						.clip(RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp, bottomStart = 12.dp, bottomEnd = 3.dp))
						.background(t.userBubble)
						.padding(horizontal = 8.dp, vertical = 4.dp),
				)
			}
			Spacer(Modifier.height(6.dp))
			Row {
				Box(Modifier.padding(top = 5.dp)) {
					Box(Modifier.size(6.dp).clip(CircleShape).background(t.accent))
				}
				Spacer(Modifier.width(5.dp))
				Text("Yep — 264 passing.", color = t.text, fontSize = 11.sp)
			}
			Spacer(Modifier.height(4.dp))
			Row {
				Spacer(Modifier.width(11.dp))
				Text("writing report…", color = t.dim, fontSize = 11.sp)
			}
		}
		Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
			Text(t.name, color = t.text, fontSize = 14.sp, modifier = Modifier.weight(1f))
			if (current) Box(Modifier.size(8.dp).clip(CircleShape).background(t.accent))
		}
	}
}
