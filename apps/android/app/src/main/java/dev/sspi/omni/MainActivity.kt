package dev.sspi.omni

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json

// sspi — **pi — one omni agent, every screen.
// Design: docs/design/ui-prd.md — "talk to a person, not a terminal".

// ---------------------------------------------------------------- themes (PRD §8)

data class SspiTheme(
	val id: String,
	val name: String,
	val mood: String,
	val bg: Color,
	val surface: Color,
	val text: Color,
	val dim: Color,
	val accent: Color,
	val accentInk: Color,
	val userBubble: Color,
	val userBubbleInk: Color,
	val line: Color,
	val danger: Color,
)

val SspiThemes = listOf(
	SspiTheme(
		"dusk", "Dusk", "lamplight",
		bg = Color(0xFF171412), surface = Color(0xFF201C19), text = Color(0xFFF2EAE0),
		dim = Color(0xFF9A8F83), accent = Color(0xFFE8965A), accentInk = Color(0xFF1A130C),
		userBubble = Color(0xFF2E2823), userBubbleInk = Color(0xFFF2EAE0),
		line = Color(0xFF2B2622), danger = Color(0xFFE5484D),
	),
	SspiTheme(
		"dawn", "Dawn", "morning paper",
		bg = Color(0xFFFAF6F0), surface = Color(0xFFFFFFFF), text = Color(0xFF2A2620),
		dim = Color(0xFF8A8177), accent = Color(0xFFD96C47), accentInk = Color(0xFFFFFFFF),
		userBubble = Color(0xFFF5E7D8), userBubbleInk = Color(0xFF4A3F33),
		line = Color(0xFFEAE2D8), danger = Color(0xFFC62A2F),
	),
	SspiTheme(
		"slate", "Slate", "cool focus",
		bg = Color(0xFF0E1116), surface = Color(0xFF151A21), text = Color(0xFFE6EDF3),
		dim = Color(0xFF8B949E), accent = Color(0xFF7AA2FF), accentInk = Color(0xFF0B1020),
		userBubble = Color(0xFF1C2740), userBubbleInk = Color(0xFFE6EDF3),
		line = Color(0xFF212833), danger = Color(0xFFF2555A),
	),
	SspiTheme(
		"paper", "Paper", "pen & ink",
		bg = Color(0xFFFFFFFF), surface = Color(0xFFF6F6F4), text = Color(0xFF141414),
		dim = Color(0xFF6B6B6B), accent = Color(0xFF141414), accentInk = Color(0xFFFFFFFF),
		userBubble = Color(0xFFEFEFEC), userBubbleInk = Color(0xFF141414),
		line = Color(0xFFE6E6E2), danger = Color(0xFFC62A2F),
	),
	SspiTheme(
		"matcha", "Matcha", "greenhouse",
		bg = Color(0xFFF3F7F0), surface = Color(0xFFFFFFFF), text = Color(0xFF22301F),
		dim = Color(0xFF7A8873), accent = Color(0xFF5B8C51), accentInk = Color(0xFFFFFFFF),
		userBubble = Color(0xFFE3EDDC), userBubbleInk = Color(0xFF2A3A26),
		line = Color(0xFFDFE8D8), danger = Color(0xFFC62A2F),
	),
)

fun themeById(id: String): SspiTheme = SspiThemes.firstOrNull { it.id == id } ?: SspiThemes.first()

class MainActivity : ComponentActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContent {
			val prefs = remember { getSharedPreferences("sspi", Context.MODE_PRIVATE) }
			var themeId by remember { mutableStateOf(prefs.getString("theme", "dusk") ?: "dusk") }
			val theme = themeById(themeId)
			val setTheme: (String) -> Unit = { id ->
				prefs.edit().putString("theme", id).apply()
				themeId = id
			}
			MaterialTheme(
				colorScheme = if (theme.id == "dusk" || theme.id == "slate") {
					darkColorScheme(primary = theme.accent, onPrimary = theme.accentInk, background = theme.bg, surface = theme.surface, onBackground = theme.text, onSurface = theme.text, secondary = theme.dim)
				} else {
					lightColorScheme(primary = theme.accent, onPrimary = theme.accentInk, background = theme.bg, surface = theme.surface, onBackground = theme.text, onSurface = theme.text, secondary = theme.dim)
				},
			) {
				Surface(modifier = Modifier.fillMaxSize(), color = theme.bg) {
					SspiApp(theme, setTheme)
				}
			}
		}
	}
}

data class Msg(val id: String, val role: String, val text: String, val source: String?, val target: String? = null, val profileId: String? = null)

data class UiTarget(val id: String?, val label: String) {
	companion object {
		val OMNI = UiTarget(null, "Omni")
	}
}

typealias ClientFactory = (
	serverUrl: String,
	token: String,
	onEvent: (ServerEvent) -> Unit,
	onConnection: (Boolean) -> Unit,
) -> SspiConnection

@Composable
fun SspiApp(theme: SspiTheme, setTheme: (String) -> Unit) {
	val context = LocalContext.current
	val store = remember { ConnectionsStore(context) }
	var connections by remember { mutableStateOf(store.load()) }
	var activeId by remember { mutableStateOf<String?>(null) }
	var showThemes by remember { mutableStateOf(false) }
	var machinesOpen by remember { mutableStateOf(false) }
	val conn = connections.firstOrNull { it.id == activeId } ?: connections.firstOrNull()

	fun save(list: List<Connection>) {
		connections = list
		store.save(list)
	}

	fun upsert(c: Connection) {
		save(listOf(c) + connections.filter { it.id != c.id })
		activeId = c.id
	}

	fun remove(id: String) {
		save(connections.filter { it.id != id })
		if (activeId == id) activeId = connections.firstOrNull()?.id
	}

	if (showThemes) {
		ThemesPage(theme, setTheme) { showThemes = false }
		return
	}

	// QR scanner for /pair codes (journeyapps zxing-embedded; CaptureActivity handles the camera)
	val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { res ->
		val text = res.contents ?: return@rememberLauncherForActivityResult
		val parsed = parsePairInput(text)
		if (parsed != null) {
			val (url, token) = parsed
			upsert(Connection(id = url, name = ConnectionsStore.hostOf(url), url = url, token = token))
		}
	}

	if (conn != null) {
		ChatScreen(
			theme = theme,
			server = conn.url,
			token = conn.token,
			onDisconnect = { remove(conn.id) },
			onOpenThemes = { showThemes = true },
			onOpenMachines = { machinesOpen = true },
			onConnectionInfo = { name, color ->
				save(connections.map { if (it.id == conn.id) it.copy(name = name ?: it.name, color = color ?: it.color) else it })
			},
		)
	} else {
		PairingScreen(
			theme = theme,
			onScan = {
				val options = ScanOptions().apply {
					setDesiredBarcodeFormats(ScanOptions.QR_CODE)
					setPrompt("scan the /pair QR on your machine")
					setBeepEnabled(false)
				}
				scanLauncher.launch(options)
			},
			onPair = { url, token ->
				upsert(Connection(id = url, name = ConnectionsStore.hostOf(url), url = url, token = token))
			},
		)
	}

	if (machinesOpen) {
		MachinesDrawer(
			theme = theme,
			connections = connections,
			activeId = conn?.id,
			onSwitch = { id ->
				activeId = id
				machinesOpen = false
			},
			onRemove = { remove(it) },
			onScan = {
				val options = ScanOptions().apply {
					setDesiredBarcodeFormats(ScanOptions.QR_CODE)
					setPrompt("scan the /pair QR on your machine")
					setBeepEnabled(false)
				}
				scanLauncher.launch(options)
			},
			onAdd = { url, token ->
				upsert(Connection(id = url, name = ConnectionsStore.hostOf(url), url = url, token = token))
				machinesOpen = false
			},
			onClose = { machinesOpen = false },
		)
	}
}

// ---------------------------------------------------------------- machines drawer

@Composable
fun MachinesDrawer(
	theme: SspiTheme,
	connections: List<Connection>,
	activeId: String?,
	onSwitch: (String) -> Unit,
	onRemove: (String) -> Unit,
	onScan: () -> Unit,
	onAdd: (String, String) -> Unit,
	onClose: () -> Unit,
) {
	var link by remember { mutableStateOf("") }
	var token by remember { mutableStateOf("") }
	var error by remember { mutableStateOf<String?>(null) }

	// single wrapping Box so scrim + panel share one hit-test/draw tree
	Box(Modifier.fillMaxSize()) {
		Box(
			Modifier
				.fillMaxSize()
				.pointerInput(Unit) { detectTapGestures { onClose() } }
				.background(Color.Black.copy(alpha = 0.45f)),
		)
		Column(
			Modifier
				.fillMaxHeight()
				.fillMaxWidth(0.84f)
				.widthIn(max = 340.dp)
				.verticalScroll(rememberScrollState())
				.background(theme.bg)
				.padding(top = WindowInsets.safeDrawing.getTop(LocalDensity.current).dp + 12.dp)
				.padding(horizontal = 14.dp)
				.padding(bottom = 20.dp),
		) {
		Text("MACHINES", color = theme.dim, fontSize = 12.sp, modifier = Modifier.padding(vertical = 6.dp))
		if (connections.isEmpty()) {
			Text("No machines paired yet.", color = theme.dim, fontSize = 13.5.sp)
		}
		for (c in connections) {
			Row(
				Modifier
					.fillMaxWidth()
					.clip(RoundedCornerShape(12.dp))
					.background(if (c.id == activeId) theme.surface else Color.Transparent)
					.clickable { onSwitch(c.id) }
					.padding(horizontal = 10.dp, vertical = 12.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Box(Modifier.size(10.dp).clip(CircleShape).background(parseHexColor(c.color) ?: theme.dim))
				Spacer(Modifier.width(10.dp))
				Text(
					c.name,
					color = theme.text,
					fontSize = 15.sp,
					fontWeight = FontWeight.SemiBold,
					maxLines = 1,
					overflow = TextOverflow.Ellipsis,
					modifier = Modifier.weight(1f),
				)
				Text(
					"✕",
					color = theme.dim,
					fontSize = 13.sp,
					modifier = Modifier
						.clickable { onRemove(c.id) }
						.padding(8.dp),
				)
			}
		}
		Spacer(Modifier.height(16.dp))
		Box(Modifier.fillMaxWidth().height(1.dp).background(theme.line))
		Spacer(Modifier.height(14.dp))
		OutlinedTextField(
			value = link,
			onValueChange = { link = it },
			placeholder = { Text("Paste pair link or server URL", color = theme.dim, fontSize = 14.sp) },
			singleLine = true,
			modifier = Modifier.fillMaxWidth().testTag("sspi.link"),
			colors = fieldColors(theme),
		)
		Spacer(Modifier.height(8.dp))
		OutlinedTextField(
			value = token,
			onValueChange = { token = it },
			placeholder = { Text("Token (skip if the link has one)", color = theme.dim, fontSize = 14.sp) },
			singleLine = true,
			modifier = Modifier.fillMaxWidth().testTag("sspi.addToken"),
			colors = fieldColors(theme),
		)
		error?.let {
			Spacer(Modifier.height(8.dp))
			Text(it, color = theme.danger, fontSize = 12.5.sp)
		}
		Spacer(Modifier.height(12.dp))
		Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			Button(
				onClick = {
					val parsed = parsePairInput(link, token)
					if (parsed == null) {
						error = "need a pair link, or a URL + token"
					} else {
						error = null
						link = ""
						token = ""
						onAdd(parsed.first, parsed.second)
					}
				},
				modifier = Modifier.weight(1f).testTag("sspi.addMachine"),
				colors = ButtonDefaults.buttonColors(containerColor = theme.accent, contentColor = theme.accentInk),
			) {
				Text("Add", fontSize = 14.sp)
			}
			Button(
				onClick = onScan,
				modifier = Modifier.weight(1f).testTag("sspi.scan"),
				colors = ButtonDefaults.buttonColors(containerColor = theme.surface, contentColor = theme.text),
			) {
				Text("Scan QR", fontSize = 14.sp)
			}
		}
		Spacer(Modifier.height(10.dp))
		Text(
			"Run /pair in any pi session on the machine to get a link or QR.",
			color = theme.dim,
			fontSize = 12.sp,
			lineHeight = 17.sp,
		)
		}
	}
}

fun parseHexColor(hex: String?): Color? {
	if (hex == null || !hex.matches(Regex("^#[0-9a-fA-F]{6}$"))) return null
	return Color(android.graphics.Color.parseColor(hex))
}

// ---------------------------------------------------------------- pairing

@Composable
fun PairingScreen(theme: SspiTheme, onScan: () -> Unit = {}, onPair: (String, String) -> Unit) {
	var server by remember { mutableStateOf("") }
	var token by remember { mutableStateOf("") }
	var error by remember { mutableStateOf<String?>(null) }

	Column(
		modifier = Modifier
			.fillMaxSize()
			.verticalScroll(rememberScrollState())
			.windowInsetsPadding(WindowInsets.safeDrawing)
			.padding(24.dp),
	) {
		Text("sspi", fontSize = 40.sp, color = theme.text)
		Text("**pi — pointer-pointer to pi", fontSize = 14.sp, color = theme.dim)
		Spacer(Modifier.height(32.dp))
		Text("Pair with your omni agent", fontSize = 20.sp, color = theme.text)
		Spacer(Modifier.height(8.dp))
		Text(
			"Scan the /pair QR, or paste the pair link. Secrets stay on the machine.",
			fontSize = 13.sp,
			color = theme.dim,
		)
		Spacer(Modifier.height(20.dp))
		OutlinedTextField(
			value = server,
			onValueChange = { server = it },
			label = { Text("Pair link or server URL") },
			placeholder = { Text("http://192.168.1.10:8787/?pair=…") },
			singleLine = true,
			modifier = Modifier.fillMaxWidth().testTag("sspi.server"),
			colors = fieldColors(theme),
		)
		Spacer(Modifier.height(12.dp))
		OutlinedTextField(
			value = token,
			onValueChange = { token = it },
			label = { Text("Token (skip if the link has one)") },
			singleLine = true,
			modifier = Modifier.fillMaxWidth().testTag("sspi.token"),
			colors = fieldColors(theme),
		)
		Spacer(Modifier.height(20.dp))
		Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
			Button(
				onClick = {
					val parsed = parsePairInput(server, token)
					if (parsed == null) {
						error = "need a pair link, or a URL + token"
					} else {
						onPair(parsed.first, parsed.second)
					}
				},
				modifier = Modifier.weight(1f).testTag("sspi.connect"),
				colors = ButtonDefaults.buttonColors(containerColor = theme.accent, contentColor = theme.accentInk),
			) {
				Text("Connect")
			}
			Button(
				onClick = onScan,
				modifier = Modifier.weight(1f).testTag("sspi.scan"),
				colors = ButtonDefaults.buttonColors(containerColor = theme.surface, contentColor = theme.text),
			) {
				Text("Scan QR")
			}
		}
		error?.let {
			Spacer(Modifier.height(12.dp))
			Text(it, color = theme.danger, fontSize = 13.sp)
		}
	}
}

@Composable
private fun fieldColors(theme: SspiTheme) = OutlinedTextFieldDefaults.colors(
	focusedTextColor = theme.text,
	unfocusedTextColor = theme.text,
	focusedBorderColor = theme.accent,
	unfocusedBorderColor = theme.line,
	cursorColor = theme.accent,
	focusedLabelColor = theme.accent,
	unfocusedLabelColor = theme.dim,
)

// ---------------------------------------------------------------- chat

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
	theme: SspiTheme,
	server: String,
	token: String,
	onDisconnect: () -> Unit,
	onOpenThemes: () -> Unit,
	onOpenMachines: () -> Unit = {},
	onConnectionInfo: (String?, String?) -> Unit = { _, _ -> },
	clientFactory: ClientFactory = ::sspiClientFactory,
	sessionsFetcher: (String, String) -> SessionsResponseDto? = { s, t -> fetchSessions(s, t) },
	pairFetcher: (String, String) -> PairInfoDto? = { s, t -> fetchPairInfo(s, t) },
) {
	val haptics = LocalHapticFeedback.current
	val context = LocalContext.current
	val messages = remember { mutableStateListOf<Msg>() }
	var connected by remember { mutableStateOf(false) }
	var agentState by remember { mutableStateOf("starting") }
	var toolLabel by remember { mutableStateOf<String?>(null) }
	var notice by remember { mutableStateOf<String?>(null) }
	var recording by remember { mutableStateOf(false) }
	var level by remember { mutableIntStateOf(0) }
	var input by remember { mutableStateOf("") }
	// start from the real OS state: if the permission is already granted (pm grant /
	// previous session), a mic press must never re-open the system dialog
	var micGranted by remember {
		mutableStateOf(
			ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
				PackageManager.PERMISSION_GRANTED,
		)
	}
	var selected by remember { mutableStateOf(UiTarget.OMNI) }
	var sheetOpen by remember { mutableStateOf(false) }
	var headerPx by remember { mutableIntStateOf(0) }
	var sessions by remember { mutableStateOf<SessionsResponseDto?>(null) }

	val chunks = remember { mutableListOf<ShortArray>() }
	val keepRecording = remember { AtomicBoolean(false) }
	var pendingVoiceId by remember { mutableStateOf<String?>(null) }

	val client = remember {
		clientFactory(
			server,
			token,
			{ evt ->
				when (evt) {
					is ServerEvent.HelloOk -> {
						agentState = evt.agent.state
						messages.clear()
						messages.addAll(evt.history.map { Msg(it.id, it.role, it.text, it.source, it.target, it.profileId) })
						// learn the machine's name + omni profile color once, off the UI thread
						thread(name = "sspi-learn") {
							try {
								val info = pairFetcher(server, token)
								val sess = sessionsFetcher(server, token)
								sessions = sess
								val omniColor = sess?.profiles?.get(sess.omniSessionId)?.color
								onConnectionInfo(info?.machine, omniColor)
							} catch (_: Exception) {
								// offline — keep the host name
							}
						}
					}
					is ServerEvent.HelloFail -> {
						notice = evt.error
						onDisconnect()
					}
					is ServerEvent.Transcript -> {
						pendingVoiceId = evt.id
						messages.add(Msg(evt.id, "user", evt.text, "voice", evt.target))
					}
					is ServerEvent.UserMessage -> {
						val idx = messages.indexOfFirst { it.id == evt.id }
						if (idx >= 0) messages[idx] = Msg(evt.id, "user", evt.text, evt.source, evt.target)
						else messages.add(Msg(evt.id, "user", evt.text, evt.source, evt.target))
						pendingVoiceId = null
					}
					is ServerEvent.AssistantDelta -> {
						val idx = messages.indexOfLast { it.id == evt.id }
						if (idx >= 0) {
							val m = messages[idx]
							messages[idx] = m.copy(text = m.text + evt.delta)
						} else {
							messages.add(Msg(evt.id, "assistant", evt.delta, null, evt.target, evt.profileId))
						}
					}
					is ServerEvent.AssistantFinal -> {
						val idx = messages.indexOfFirst { it.id == evt.id }
						if (idx >= 0) messages[idx] = Msg(evt.id, "assistant", evt.text, null, evt.target, evt.profileId)
						else messages.add(Msg(evt.id, "assistant", evt.text, null, evt.target, evt.profileId))
					}
					is ServerEvent.AgentStateEvt -> {
						agentState = evt.state
						toolLabel = if (evt.state == "tool") evt.toolName else null
					}
					is ServerEvent.ToolEvent -> {
						if (evt.phase == "start") {
							agentState = "tool"
							toolLabel = evt.label ?: evt.toolName
						} else toolLabel = null
					}
					is ServerEvent.AgentNotify -> notice = evt.message
					is ServerEvent.ErrorEvt -> notice = evt.message
					is ServerEvent.AgentInfoEvt -> {}
				}
			},
		) { ok -> connected = ok }
	}

	DisposableEffect(Unit) {
		client.connect()
		onDispose { client.close() }
	}

	LaunchedEffect(notice) {
		if (notice != null) {
			delay(6000)
			notice = null
		}
	}

	// poll session states while a peer is selected or the sheet is open
	LaunchedEffect(sheetOpen, selected) {
		while (sheetOpen || selected.id != null) {
			sessions = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
				sessionsFetcher(server, token)
			}
			delay(5000)
		}
	}

	fun statusLine(): String =
		if (selected.id != null) {
			val all = (sessions?.projects ?: emptyList()).flatMap { it.sessions } + (sessions?.others ?: emptyList())
			when (all.firstOrNull { it.sessionId == selected.id }?.state) {
				"busy" -> "working…"
				"unreachable" -> "unreachable"
				else -> ""
			}
		} else {
			when {
				!connected -> "connecting…"
				agentState == "tool" -> (toolLabel ?: "working") + "…"
				agentState == "thinking" -> "thinking…"
				agentState == "streaming" -> "typing…"
				agentState == "starting" -> "waking up…"
				else -> ""
			}
		}

	fun sendChat() {
		val t = input.trim()
		if (t.isEmpty()) return
		client.sendChat(t, selected.id)
		input = ""
	}

	fun startRecording() {
		chunks.clear()
		keepRecording.set(true)
		recording = true
		haptics.performHapticFeedback(HapticFeedbackType.LongPress)
		val minBuf = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
		// generous buffer: absorbs audio bursts and GC pauses instead of dropping samples
		val record = AudioRecord(
			MediaRecorder.AudioSource.MIC,
			16000,
			AudioFormat.CHANNEL_IN_MONO,
			AudioFormat.ENCODING_PCM_16BIT,
			maxOf(minBuf * 2, 32000 * 2),
		)
		record.startRecording()
		thread(name = "sspi-rec") {
			val buf = ShortArray(1600) // 100 ms @16 kHz
			while (keepRecording.get()) {
				val n = record.read(buf, 0, buf.size)
				if (n > 0) {
					chunks.add(buf.copyOf(n))
					var acc = 0L
					for (i in 0 until n) acc += buf[i] * buf[i]
					val rms = kotlin.math.sqrt(acc.toDouble() / n)
					level = (rms * 600).toInt().coerceIn(0, 100)
				}
			}
			record.stop()
			record.release()
		}
	}

	fun stopRecordingAndSend() {
		if (!recording) return
		keepRecording.set(false)
		recording = false
		haptics.performHapticFeedback(HapticFeedbackType.LongPress)
		// give the reader thread a beat to flush the last chunk
		thread(name = "sspi-send") {
			Thread.sleep(150)
			val wav = WavEncoder.encode(chunks.toList())
			if (wav.size <= 44) {
				notice = "nothing recorded — hold the button and speak"
				return@thread
			}
			client.uploadVoice(wav) { ok, msg ->
				if (!ok) notice = msg
			}
		}
	}

	val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
		if (granted) {
			micGranted = true
			startRecording()
		} else notice = "microphone permission denied"
	}

	// watchdog: never record longer than 60 s, even if the release gesture is lost
	LaunchedEffect(recording) {
		if (recording) {
			delay(60_000)
			if (keepRecording.get()) stopRecordingAndSend()
		}
	}

	val listState = rememberLazyListState()
	LaunchedEffect(messages.size, agentState) {
		if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
	}

	val visible = messages.filter { (it.target) == selected.id }
	val status = statusLine()
	val busy = selected.id == null && (agentState == "thinking" || agentState == "tool" || agentState == "streaming")
	val dotDesc = if (connected) "connected" else "connecting…"

	Column(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
		// ---- presence bar (PRD §3): ☰ = machines · tap = target tree
		Row(
			modifier = Modifier
				.fillMaxWidth()
				.background(theme.bg)
				.clickable { sheetOpen = true }
				.semantics { contentDescription = "sessions" }
				.onGloballyPositioned { headerPx = it.size.height }
				.padding(horizontal = 16.dp, vertical = 12.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Text(
				"☰",
				color = theme.dim,
				fontSize = 17.sp,
				modifier = Modifier
					.clickable { onOpenMachines() }
					.padding(8.dp)
					.semantics { contentDescription = "machines" },
			)
			Spacer(Modifier.width(8.dp))
			Box(
				modifier = Modifier
					.size(10.dp)
					.clip(CircleShape)
					.background(
						when {
							!connected -> theme.dim
							busy -> theme.accent
							else -> Color(0xFF3FD68F)
						}
					)
					.semantics { contentDescription = dotDesc },
			)
			Spacer(Modifier.width(12.dp))
			Column(Modifier.weight(1f)) {
				Row(verticalAlignment = Alignment.CenterVertically) {
					Text(selected.label, color = theme.text, fontSize = 16.sp)
					Spacer(Modifier.width(6.dp))
					Text("▾", color = theme.dim, fontSize = 11.sp)
				}
				if (status.isNotEmpty()) {
					Text(status, color = theme.dim, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
				}
			}
			Text(
				"◐",
				color = theme.dim,
				fontSize = 18.sp,
				modifier = Modifier
					.clickable { onOpenThemes() }
					.padding(8.dp),
			)
		}

		// ---- conversation (assistant speaks in open text, user in a bubble)
		LazyColumn(
			state = listState,
			modifier = Modifier.weight(1f).fillMaxWidth(),
			contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 20.dp),
			verticalArrangement = Arrangement.spacedBy(14.dp),
		) {
			if (visible.isEmpty()) {
				item {
					Column(Modifier.fillMaxWidth().padding(top = 120.dp), horizontalAlignment = Alignment.CenterHorizontally) {
						Text("Hey, it's ${selected.label}.", color = theme.text, fontSize = 20.sp, textAlign = TextAlign.Center)
						Spacer(Modifier.height(6.dp))
						Text(
							"Tell me what to build, ask about a repo,\nor hold the mic and just talk.",
							color = theme.dim,
							fontSize = 13.5.sp,
							textAlign = TextAlign.Center,
							lineHeight = 20.sp,
						)
					}
				}
			}
			items(visible, key = { it.id }) { m ->
				if (m.role == "user") {
					Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
						Text(
							text = (if (m.source == "voice") "🎙 " else "") + m.text.ifEmpty { "…" },
							color = theme.userBubbleInk,
							fontSize = 17.sp,
							modifier = Modifier
								.widthIn(max = 300.dp)
								.clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 20.dp, bottomEnd = 6.dp))
								.background(theme.userBubble)
								.padding(horizontal = 14.dp, vertical = 10.dp),
						)
					}
				} else {
					val prof = m.profileId?.let { pid -> sessions?.profiles?.get(pid) }
					if (prof != null) {
						// a profiled agent replied (delegation) — tint the bubble with its color
						Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
							Text(prof.name, color = theme.dim, fontSize = 12.sp, modifier = Modifier.padding(end = 4.dp, bottom = 3.dp))
							Text(
								text = m.text.ifEmpty { "…" },
								color = Color(0xFF141210),
								fontSize = 17.sp,
								lineHeight = 26.sp,
								modifier = Modifier
									.widthIn(max = 300.dp)
									.clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 20.dp, bottomEnd = 6.dp))
									.background(parseHexColor(prof.color) ?: theme.accent)
									.padding(horizontal = 14.dp, vertical = 10.dp),
							)
						}
					} else {
						Row(Modifier.fillMaxWidth()) {
							Box(Modifier.width(8.dp).padding(top = 8.dp)) {
								Box(Modifier.size(7.dp).clip(CircleShape).background(theme.accent.copy(alpha = 0.85f)))
							}
							Spacer(Modifier.width(10.dp))
							Text(m.text.ifEmpty { "…" }, color = theme.text, fontSize = 17.sp, lineHeight = 26.sp)
						}
					}
				}
			}
			if (busy) {
				item {
					Row(
						Modifier.padding(start = 18.dp),
						verticalAlignment = Alignment.CenterVertically,
						horizontalArrangement = Arrangement.spacedBy(8.dp),
					) {
						Text(status.ifEmpty { "thinking…" }, color = theme.dim, fontSize = 13.5.sp)
						CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = theme.accent)
						Text(
							"stop",
							color = theme.dim,
							fontSize = 12.sp,
							modifier = Modifier
								.clip(RoundedCornerShape(999.dp))
								.border(1.dp, theme.line, RoundedCornerShape(999.dp))
								.clickable { client.abort() }
								.padding(horizontal = 10.dp, vertical = 2.dp),
						)
					}
				}
			}
		}

		// ---- composer pill (PRD §7): input + inline mic, IME sends
		Column(Modifier.background(theme.bg)) {
			Row(
				modifier = Modifier
					.fillMaxWidth()
					.padding(horizontal = 16.dp, vertical = 10.dp)
					.clip(RoundedCornerShape(26.dp))
					.background(theme.surface)
					.border(1.dp, if (recording) theme.danger else theme.line, RoundedCornerShape(26.dp))
					.padding(start = 18.dp, top = 4.dp, bottom = 4.dp, end = 6.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				if (recording) {
					Row(
						Modifier.weight(1f).height(44.dp),
						verticalAlignment = Alignment.CenterVertically,
						horizontalArrangement = Arrangement.spacedBy(2.dp),
					) {
						repeat(9) { i ->
							Box(
								Modifier
									.width(3.dp)
									.height((6 + ((level * 3 + i * 13) % 22)).dp)
									.clip(RoundedCornerShape(2.dp))
									.background(theme.danger),
							)
						}
						Spacer(Modifier.width(8.dp))
						Text("listening… release to send", color = theme.dim, fontSize = 14.sp)
					}
				} else {
					TextFieldWithSend(
						value = input,
						onValueChange = { input = it },
						onSend = { sendChat() },
						placeholder = "Message ${selected.label}…",
						theme = theme,
						enabled = !recording,
						modifier = Modifier.weight(1f).testTag("sspi.composer"),
					)
				}
				Box(
					modifier = Modifier
						.size(44.dp)
						.testTag("sspi.mic")
						.clip(CircleShape)
						.background(if (recording) theme.danger else theme.accent)
						.pointerInput(Unit) {
							detectTapGestures(
								onPress = {
									when {
										recording -> {
											tryAwaitRelease()
											stopRecordingAndSend()
										}
										micGranted -> {
											startRecording()
											tryAwaitRelease()
											stopRecordingAndSend()
										}
										else -> permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
									}
								},
							)
						},
					contentAlignment = Alignment.Center,
				) {
					Text(if (recording) "■" else "●", color = if (recording) Color.White else theme.accentInk, fontSize = 16.sp)
				}
			}
			Spacer(Modifier.height(10.dp))
		}
	}

	// ---- target tree drawer (PRD §4): drops from the presence bar, in front of chat
	if (sheetOpen) {
		Box(Modifier.fillMaxSize()) {
			Box(
				Modifier
					.fillMaxSize()
					.pointerInput(Unit) { detectTapGestures { sheetOpen = false } }
					.background(Color.Black.copy(alpha = 0.45f)),
			)
			val headerDp = with(LocalDensity.current) { headerPx.toDp() }
			Column(
				Modifier
					.padding(top = headerDp + 8.dp, start = 12.dp, end = 12.dp)
					.widthIn(max = 340.dp)
					.heightIn(max = 460.dp)
					.verticalScroll(rememberScrollState())
					.clip(RoundedCornerShape(18.dp))
					.background(theme.bg)
					.border(1.dp, theme.line, RoundedCornerShape(18.dp))
					.padding(vertical = 8.dp),
			) {
			Text(
				"SESSIONS",
				color = theme.dim,
				fontSize = 12.sp,
				modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
			)
			TreeRow(theme, "Omni", "the whole fleet", selected.id == null, depth = 0) {
				selected = UiTarget.OMNI
				sheetOpen = false
			}
			for (p in sessions?.projects ?: emptyList()) {
				val mains = p.sessions.filter { it.worktree == null }
				if (mains.isEmpty()) {
					TreeRow(theme, "${p.name} — no open session", "", depth = 1, dim = true)
				}
				for ((i, s) in mains.withIndex()) {
					val label = if (i == 0) p.name else (s.name ?: "main")
					TreeRow(theme, label, stateLabel(s.state), selected.id == s.sessionId, depth = 1) {
						selected = UiTarget(s.sessionId, label)
						sheetOpen = false
					}
				}
				for (s in p.sessions) {
					if (s.worktree == null) continue
					TreeRow(theme, "wt/${s.worktree}", stateLabel(s.state), selected.id == s.sessionId, depth = 2) {
						selected = UiTarget(s.sessionId, "wt/${s.worktree}")
						sheetOpen = false
					}
				}
			}
			for (s in sessions?.others ?: emptyList()) {
				val label = s.name ?: "#${s.sessionId.take(4)}"
				TreeRow(theme, label, stateLabel(s.state), selected.id == s.sessionId, depth = 1) {
					selected = UiTarget(s.sessionId, label)
					sheetOpen = false
				}
			}
			Box(
				Modifier
					.padding(horizontal = 16.dp, vertical = 6.dp)
					.fillMaxWidth()
					.height(1.dp)
					.background(theme.line),
			)
			Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
				Text(
					"Unpair this device",
					color = theme.dim,
					fontSize = 14.sp,
					modifier = Modifier
						.fillMaxWidth()
						.clip(RoundedCornerShape(12.dp))
						.border(1.dp, theme.line, RoundedCornerShape(12.dp))
						.clickable { sheetOpen = false; onDisconnect() }
						.padding(12.dp),
					textAlign = TextAlign.Center,
				)
			}
		}
		}
	}

	notice?.let { n ->
		Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
			Surface(
				color = Color(0xFF2A1518),
				shape = RoundedCornerShape(14.dp),
				border = androidx.compose.foundation.BorderStroke(1.dp, theme.danger),
				modifier = Modifier.padding(bottom = 140.dp).widthIn(max = 340.dp),
			) {
				Text(n, color = Color(0xFFFFB4B4), fontSize = 13.sp, modifier = Modifier.padding(12.dp))
			}
		}
	}
}

@Composable
private fun TextFieldWithSend(
	value: String,
	onValueChange: (String) -> Unit,
	onSend: () -> Unit,
	placeholder: String,
	theme: SspiTheme,
	enabled: Boolean,
	modifier: Modifier = Modifier,
) {
	OutlinedTextField(
		value = value,
		onValueChange = onValueChange,
		placeholder = { Text(placeholder, color = theme.dim) },
		singleLine = true,
		enabled = enabled,
		textStyle = TextStyle(color = theme.text, fontSize = 17.sp),
		keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Send),
		keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSend = { onSend() }),
		colors = TextFieldDefaults.colors(
			focusedContainerColor = Color.Transparent,
			unfocusedContainerColor = Color.Transparent,
			focusedTextColor = theme.text,
			unfocusedTextColor = theme.text,
			cursorColor = theme.accent,
			focusedIndicatorColor = Color.Transparent,
			unfocusedIndicatorColor = Color.Transparent,
		),
		modifier = modifier.testTag("sspi.composer"),
	)
}

private fun stateLabel(state: String): String = when (state) {
	"busy" -> "working…"
	"unreachable" -> "unreachable"
	else -> "idle"
}

/** One row of the target tree; draws a vertical guide cell per ancestor level. */
@Composable
private fun TreeRow(
	theme: SspiTheme,
	name: String,
	state: String,
	active: Boolean = false,
	depth: Int = 0,
	dim: Boolean = false,
	onClick: (() -> Unit)? = null,
) {
	Row(
		Modifier
			.fillMaxWidth()
			.height(IntrinsicSize.Min)
			.then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)
			.background(if (active) theme.surface else Color.Transparent),
	) {
		repeat(depth) {
			Box(Modifier.width(18.dp).fillMaxHeight()) {
				Box(Modifier.fillMaxHeight().width(1.dp).background(theme.line).align(Alignment.CenterEnd))
			}
		}
		Box(Modifier.width(12.dp).fillMaxHeight()) {
			if (active) {
				Box(Modifier.width(3.dp).height(18.dp).background(theme.accent).align(Alignment.CenterStart))
			}
		}
		Text(
			name,
			color = if (dim) theme.dim else theme.text,
			fontSize = 16.sp,
			fontWeight = if (dim) FontWeight.Normal else if (depth <= 1) FontWeight.SemiBold else FontWeight.Normal,
			maxLines = 1,
			overflow = TextOverflow.Ellipsis,
			modifier = Modifier.weight(1f).padding(vertical = 12.dp),
		)
		if (state.isNotEmpty()) {
			Text(state, color = theme.dim, fontSize = 12.5.sp, modifier = Modifier.padding(start = 8.dp, end = 16.dp))
		} else {
			Spacer(Modifier.width(16.dp))
		}
	}
}

// ---- /api/sessions fetch ----

private val sessionJson = Json { ignoreUnknownKeys = true }

fun fetchSessions(server: String, token: String): SessionsResponseDto? {
	return try {
		val conn = URL("${server.trimEnd('/')}/api/sessions").openConnection() as HttpURLConnection
		conn.setRequestProperty("Authorization", "Bearer $token")
		conn.connectTimeout = 3000
		conn.readTimeout = 5000
		val body = conn.inputStream.readBytes().decodeToString()
		conn.disconnect()
		sessionJson.decodeFromString(SessionsResponseDto.serializer(), body)
	} catch (_: Exception) {
		null
	}
}

fun fetchPairInfo(server: String, token: String): PairInfoDto? {
	return try {
		val conn = URL("${server.trimEnd('/')}/api/pair").openConnection() as HttpURLConnection
		conn.setRequestProperty("Authorization", "Bearer $token")
		conn.connectTimeout = 3000
		conn.readTimeout = 5000
		val body = conn.inputStream.readBytes().decodeToString()
		conn.disconnect()
		sessionJson.decodeFromString(PairInfoDto.serializer(), body)
	} catch (_: Exception) {
		null
	}
}
