// Task cards (#15) + artifact cards (#17) for the Android client — Compose
// twins of the web's Task.tsx / Artifact.tsx, sharing the documented sandbox
// posture: the artifact viewer runs the content in a WebView with scripts on
// but the web's CSP injected FIRST (zero network: no fetch/XHR/img/fonts —
// only inline style/script and data: assets), no file/content access, and no
// DOM storage — an opaque, self-contained document that cannot phone home.

package dev.pppi.omni

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text

// ---------------------------------------------------------------- tasks

/** merge a live update over the entry-time snapshot; live wins (web liveTask) */
fun liveTask(entryTask: TaskUpdate, live: Map<String, TaskUpdate>): TaskUpdate = live[entryTask.id] ?: entryTask

/** per-status detail line (web TaskCard fallbacks) */
fun taskDetail(task: TaskUpdate): String {
	val fallback = when (task.status) {
		"queued" -> "queued — starting soon"
		"running" -> "running…"
		"done" -> "done — result below/in the conversation"
		"failed" -> "failed — see the reply for why"
		else -> task.status
	}
	return task.detail ?: fallback
}

fun taskGlyph(status: String): String = when (status) {
	"queued" -> "○"
	"running" -> "◐"
	"done" -> "●"
	"failed" -> "✕"
	else -> "○"
}

/** A live job card: the message that announced the task carries it; later
 *  `task` events flip it in place through the live-task registry. */
@androidx.compose.runtime.Composable
fun TaskCard(task: TaskUpdate, theme: PppiTheme) {
	val glyphColor = when (task.status) {
		"queued" -> theme.dim
		"running" -> theme.accent
		"done" -> theme.dim
		"failed" -> theme.danger
		else -> theme.dim
	}
	Row(
		Modifier
			.fillMaxWidth()
			.clip(RoundedCornerShape(10.dp))
			.background(theme.surface)
			.border(1.dp, theme.line, RoundedCornerShape(10.dp))
			.padding(horizontal = 12.dp, vertical = 10.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Text(taskGlyph(task.status), color = glyphColor, fontSize = 18.sp)
		Spacer(Modifier.width(10.dp))
		Column {
			Text(task.title, color = theme.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
			Text(taskDetail(task), color = theme.dim, fontSize = 12.sp)
		}
	}
}

// ---------------------------------------------------------------- artifacts

/** the web's ARTIFACT_CSP, byte for byte — injected as the very first thing */
const val ARTIFACT_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:"

/** document = CSP meta (first!) + the artifact's own document */
fun artifactDocument(artifact: Artifact): String =
	"<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"$ARTIFACT_CSP\">${artifact.content}"

/** A rich view arrives with a reply and renders as a tappable card; unknown
 *  kinds degrade to an inert card (web parity). */
@androidx.compose.runtime.Composable
fun ArtifactCard(artifact: Artifact, theme: PppiTheme, onOpen: (Artifact) -> Unit) {
	val supported = artifact.kind == "html"
	Row(
		Modifier
			.fillMaxWidth()
			.clip(RoundedCornerShape(10.dp))
			.background(if (supported) theme.surface else theme.surface.copy(alpha = 0.5f))
			.border(1.dp, theme.line, RoundedCornerShape(10.dp))
			.then(
				if (supported) Modifier.clickable { onOpen(artifact) } else Modifier,
			)
			.padding(horizontal = 12.dp, vertical = 10.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Text("◫", color = if (supported) theme.accent else theme.dim, fontSize = 20.sp)
		Spacer(Modifier.width(10.dp))
		Column(Modifier.weight(1f)) {
			Text(artifact.title, color = theme.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
			Text(
				if (supported) "${artifact.kind} view · tap to open" else "${artifact.kind} — not supported on this client yet",
				color = theme.dim,
				fontSize = 12.sp,
			)
		}
		if (supported) {
			Spacer(Modifier.width(8.dp))
			Text("→", color = theme.dim, fontSize = 16.sp)
		}
	}
}
