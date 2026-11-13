package dev.pppi.omni

// TASK 1 of the Android mirror program (#57): the fleet as a first-class
// screen + per-session detail. Pure row-mapping lives here (sessionsRows) so
// drawer state is unit-testable; the composables render it with the same
// profile-color identity the web drawer uses (#45/#46 parity).

import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One row of the sessions screen — a pure projection of the /api/sessions
 *  payload. `colorHex` is the session's profile color (null = theme accent
 *  fallback, mirroring the web drawer). */
data class SessionRow(
	val key: String,
	val label: String,
	val state: String,
	val colorHex: String?,
	val depth: Int,
	val kind: Kind,
	val session: PeerSessionDto? = null,
	val projectName: String? = null,
) {
	enum class Kind { OMNI, MAIN, WORKTREE, OTHER, EMPTY_PROJECT }
}

/** sessionsRows: omni row, then per project (mains, worktrees), then others.
 *  Colors come from the profiles map (derived entries included server-side);
 *  sessions without one fall back to null → accent at render time. */
fun sessionsRows(
	dto: SessionsResponseDto?,
	profiles: Map<String, ProfileDto>,
): List<SessionRow> {
	if (dto == null) return listOf(
		SessionRow("omni", "Omni", "idle", profiles[dto_omniId(dto)]?.color, 0, SessionRow.Kind.OMNI),
	)
	val rows = mutableListOf(
		SessionRow(
			key = "omni",
			label = "Omni",
			state = "idle",
			colorHex = profiles[dto.omniSessionId]?.color,
			depth = 0,
			kind = SessionRow.Kind.OMNI,
		),
	)
	for (p in dto.projects) {
		val mains = p.sessions.filter { it.worktree == null }
		if (mains.isEmpty()) {
			rows.add(SessionRow("proj-${p.name}", p.name, "", null, 1, SessionRow.Kind.EMPTY_PROJECT, projectName = p.name))
		}
		for (s in mains) {
			val label = s.name ?: "#${s.sessionId.take(4)}"
			rows.add(
				SessionRow(
					key = s.sessionId,
					label = label,
					state = s.state,
					colorHex = profiles[s.sessionId]?.color,
					depth = 1,
					kind = SessionRow.Kind.MAIN,
					session = s,
					projectName = p.name,
				),
			)
		}
		for (s in p.sessions) {
			if (s.worktree == null) continue
			rows.add(
				SessionRow(
					key = s.sessionId,
					label = s.worktree,
					state = s.state,
					colorHex = profiles[s.sessionId]?.color,
					depth = 2,
					kind = SessionRow.Kind.WORKTREE,
					session = s,
					projectName = p.name,
				),
			)
		}
	}
	for (s in dto.others) {
		rows.add(
			SessionRow(
				key = s.sessionId,
				label = s.name ?: "#${s.sessionId.take(4)}",
				state = s.state,
				colorHex = profiles[s.sessionId]?.color,
				depth = 1,
				kind = SessionRow.Kind.OTHER,
				session = s,
			),
		)
	}
	return rows
}

private fun dto_omniId(dto: SessionsResponseDto?): String = dto?.omniSessionId ?: "omni"

fun stateLabelOf(state: String): String = when (state) {
	"busy", "busy+queued" -> "working…"
	"unreachable" -> "unreachable"
	else -> "idle"
}

// ---------------------------------------------------------------- dots

/** profile dot with web-drawer semantics: busy pulses, unreachable hollows */
@Composable
fun ProfileDot(colorHex: String?, state: String, theme: PppiTheme) {
	val fill = colorHex?.let { parseHexColorOrNull(it) } ?: theme.accent
	val pulse by if (state == "busy" || state == "busy+queued") {
		rememberInfiniteTransition(label = "busy").animateFloat(
			initialValue = 1f,
			targetValue = 0.35f,
			animationSpec = infiniteRepeatable(tween(700)),
			label = "alpha",
		)
	} else {
		androidx.compose.runtime.remember { androidx.compose.runtime.mutableFloatStateOf(1f) }
	}
	Box(
		Modifier
			.size(10.dp)
			.clip(CircleShape)
			.then(
				if (state == "unreachable") {
					Modifier.border(1.5.dp, theme.dim, CircleShape)
				} else {
					Modifier
						.background(fill.copy(alpha = if (state == "busy" || state == "busy+queued") pulse else 1f))
						.border(1.dp, theme.bg, CircleShape)
				},
			),
	)
}

fun parseHexColorOrNull(hex: String): Color? = try {
	parseHexColor(hex)
} catch (_: Exception) {
	null
}

// ---------------------------------------------------------------- screens

/** the fleet list — replaces the dropdown sheet as the program foundation */
@Composable
fun SessionsScreen(
	theme: PppiTheme,
	rows: List<SessionRow>,
	selectedId: String?,
	onPick: (SessionRow) -> Unit,
	onOpenDetail: (SessionRow) -> Unit,
	onBack: () -> Unit,
) {
	Column(Modifier.fillMaxSize().background(theme.bg).statusBarsPadding()) {
		Row(
			Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Text("‹", color = theme.dim, fontSize = 26.sp, modifier = Modifier.clickable(onClick = onBack).padding(end = 12.dp))
			Text("Sessions", color = theme.text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
		}
		Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
			for (row in rows) {
				Row(
					Modifier
						.fillMaxWidth()
						.clickable { onPick(row) }
						.padding(start = 16.dp + (row.depth * 18).dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
					verticalAlignment = Alignment.CenterVertically,
				) {
					if (row.kind == SessionRow.Kind.EMPTY_PROJECT) {
						Text("${row.label} — no open session", color = theme.dim, fontSize = 15.sp)
					} else {
						ProfileDot(row.colorHex, row.state, theme)
						Spacer(Modifier.width(10.dp))
						Column(Modifier.weight(1f)) {
							Text(
								row.label,
								color = if (selectedId == row.key) theme.text else theme.text.copy(alpha = 0.9f),
								fontSize = 16.sp,
								fontWeight = if (selectedId == row.key) FontWeight.SemiBold else FontWeight.Normal,
							)
							if (row.state.isNotEmpty()) {
								Text(
									stateLabelOf(row.state) + if (selectedId == row.key) " · talking here" else "",
									color = theme.dim,
									fontSize = 12.5.sp,
								)
							}
						}
						// ⓘ opens the detail view
						Text(
							"ⓘ",
							color = theme.dim,
							fontSize = 16.sp,
							modifier = Modifier
								.clip(RoundedCornerShape(8.dp))
								.clickable { onOpenDetail(row) }
								.padding(horizontal = 10.dp, vertical = 6.dp),
						)
					}
				}
				if (row.kind == SessionRow.Kind.MAIN || row.kind == SessionRow.Kind.EMPTY_PROJECT) {
					Box(Modifier.padding(start = 16.dp, end = 16.dp).fillMaxWidth().height(1.dp).background(theme.line.copy(alpha = 0.5f)))
				}
			}
			Spacer(Modifier.height(24.dp))
		}
	}
}

/** per-session detail: everything the wire carries about a session today.
 *  (tokens in/out arrive with #55; uptime/last-activity are not on the wire
 *  yet — the omni target shows live model/ctx from the status stream.) */
@Composable
fun SessionDetailScreen(
	theme: PppiTheme,
	row: SessionRow,
	profile: ProfileDto?,
	omniStatus: AgentStatusDto?,
	onBack: () -> Unit,
) {
	Column(Modifier.fillMaxSize().background(theme.bg).statusBarsPadding().verticalScroll(rememberScrollState())) {
		Row(
			Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Text("‹", color = theme.dim, fontSize = 26.sp, modifier = Modifier.clickable(onClick = onBack).padding(end = 12.dp))
			Text(row.label, color = theme.text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
		}
		Row(
			Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			ProfileDot(row.colorHex, row.state, theme)
			Spacer(Modifier.width(10.dp))
			Text(stateLabelOf(row.state), color = theme.dim, fontSize = 14.sp)
		}
		if (profile?.description?.isNotEmpty() == true) {
			DetailBlock(theme, "About", profile.description)
		}
		row.session?.let { s ->
			DetailBlock(theme, "Working dir", s.cwd)
			DetailBlock(theme, "Branch", s.branch)
			s.worktree?.let { DetailBlock(theme, "Worktree", it) }
			row.projectName?.let { DetailBlock(theme, "Repo", it) }
			DetailBlock(theme, "Session id", s.sessionId)
		}
		// the omni row shows the live agent status (model / ctx / thinking)
		if (row.kind == SessionRow.Kind.OMNI && omniStatus != null) {
			omniStatus.model?.let { m ->
				DetailBlock(theme, "Model", "${m.provider}/${m.id}")
				DetailBlock(theme, "Context", "${m.contextWindow / 1000}k window")
			}
			omniStatus.context?.let { c ->
				DetailBlock(theme, "Context used", "${c.tokens}/${c.contextWindow} (${c.percent?.let { "${it.toInt()}%" } ?: "—"})")
			}
			DetailBlock(theme, "Thinking", omniStatus.thinkingLevel)
		}
		if (row.kind != SessionRow.Kind.OMNI) {
			DetailBlock(
				theme,
				"History",
				"live messages while this session is targeted — full per-peer history lands with the mirror program's later tasks",
				dim = true,
			)
		}
	}
}

@Composable
private fun DetailBlock(theme: PppiTheme, title: String, value: String, dim: Boolean = false) {
	Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
		Text(title.uppercase(), color = theme.dim, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
		Text(value, color = if (dim) theme.dim else theme.text, fontSize = 15.sp)
	}
}

// ---------------------------------------------------------------- attachments

/** attachment chips under a sent message (#50 wire, Android v1): image
 *  thumbs load async via okhttp (already a dependency); files render as
 *  name chips. Full upload composer is TASK 3 of the mirror program. */
@Composable
fun AttachmentChips(
	theme: PppiTheme,
	attachments: List<AttachmentRef>,
	serverUrl: String,
	token: String,
) {
	if (attachments.isEmpty()) return
	Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
		for (a in attachments) {
			if (a.mime.startsWith("image/")) {
				AsyncImageThumb(url = "${serverUrl.removeSuffix("/")}${a.url}?token=$token", alt = a.name, theme = theme)
			} else {
				Text(
					"📄 ${a.name} · ${a.size}B",
					color = theme.dim,
					fontSize = 12.sp,
					modifier = Modifier
						.clip(RoundedCornerShape(8.dp))
						.border(1.dp, theme.line, RoundedCornerShape(8.dp))
						.padding(horizontal = 8.dp, vertical = 4.dp),
				)
			}
		}
	}
}

@Composable
private fun AsyncImageThumb(url: String, alt: String, theme: PppiTheme) {
	var bitmap by androidx.compose.runtime.remember(url) { androidx.compose.runtime.mutableStateOf<android.graphics.Bitmap?>(null) }
	androidx.compose.runtime.LaunchedEffect(url) {
		kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
			try {
				val client = okhttp3.OkHttpClient.Builder().connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS).build()
				val req = okhttp3.Request.Builder().url(url).build()
				client.newCall(req).execute().use { resp ->
					if (resp.isSuccessful) {
						resp.body?.byteStream()?.use { android.graphics.BitmapFactory.decodeStream(it) }
					} else {
						null
					}
				}
			} catch (_: Exception) {
				null
			}
		}?.let { bitmap = it }
	}
	val bmp = bitmap
	if (bmp != null) {
		androidx.compose.foundation.Image(
			bitmap = bmp.asImageBitmap(),
			contentDescription = alt,
			contentScale = androidx.compose.ui.layout.ContentScale.Crop,
			modifier = Modifier
				.size(84.dp)
				.clip(RoundedCornerShape(10.dp))
				.border(1.dp, theme.line, RoundedCornerShape(10.dp)),
		)
	} else {
		Box(
			Modifier
				.size(84.dp)
				.clip(RoundedCornerShape(10.dp))
				.border(1.dp, theme.line, RoundedCornerShape(10.dp)),
			contentAlignment = Alignment.Center,
		) {
			Text("🖼", color = theme.dim, fontSize = 20.sp)
		}
	}
}
