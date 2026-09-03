package dev.sspi.omni

import android.Manifest
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlinx.coroutines.delay

// sspi — **pi — one omni agent, every screen.
// Single session by design: this app IS a window onto the omni conversation,
// voice-first (hold to talk), text as the fallback.

private val Bg = Color(0xFF0B0E14)
private val Panel = Color(0xFF131824)
private val Line = Color(0xFF232B3D)
private val Text0 = Color(0xFFE7ECF5)
private val Dim = Color(0xFF8B95A9)
private val Accent = Color(0xFF7AA2FF)
private val Rec = Color(0xFFFF5D5D)
private val UserBubble = Color(0xFF1D2B4F)

class MainActivity : ComponentActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContent {
			MaterialTheme(
				colorScheme = darkColorScheme(
					background = Bg,
					surface = Panel,
					primary = Accent,
					onPrimary = Bg,
					secondary = Dim,
					onBackground = Text0,
					onSurface = Text0,
				),
			) {
				Surface(modifier = Modifier.fillMaxSize(), color = Bg) {
					SspiApp()
				}
			}
		}
	}
}

data class Msg(val id: String, val role: String, var text: String, val source: String?)

@Composable
fun SspiApp() {
	val context = LocalContext.current
	val prefs = remember { context.getSharedPreferences("sspi", Context.MODE_PRIVATE) }
	var server by remember { mutableStateOf(prefs.getString("server", "") ?: "") }
	var token by remember { mutableStateOf(prefs.getString("token", "") ?: "") }

	if (server.isNotBlank() && token.isNotBlank()) {
		ChatScreen(
			server = server,
			token = token,
			onDisconnect = {
				prefs.edit().clear().apply()
				server = ""
				token = ""
			},
		)
	} else {
		PairingScreen(
			initialServer = prefs.getString("server", "") ?: "",
			onPair = { s, t ->
				prefs.edit().putString("server", s).putString("token", t).apply()
				server = s
				token = t
			},
		)
	}
}

@Composable
fun PairingScreen(initialServer: String, onPair: (String, String) -> Unit) {
	var server by remember { mutableStateOf(initialServer) }
	var token by remember { mutableStateOf("") }
	var error by remember { mutableStateOf<String?>(null) }

	Column(
		modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(24.dp),
		verticalArrangement = Arrangement.Center,
	) {
		Text("sspi", fontSize = 40.sp, color = Text0)
		Text("**pi — pointer-pointer to pi", fontSize = 14.sp, color = Dim)
		Spacer(Modifier.height(32.dp))
		Text("Pair with your omni agent", fontSize = 20.sp, color = Text0)
		Spacer(Modifier.height(8.dp))
		Text(
			"Start the sspi server on your Mac. It prints a pairing token — secrets stay on the Mac.",
			fontSize = 13.sp,
			color = Dim,
		)
		Spacer(Modifier.height(20.dp))
		OutlinedTextField(
			value = server,
			onValueChange = { server = it },
			label = { Text("Server") },
			placeholder = { Text("http://192.168.1.10:8787") },
			singleLine = true,
			modifier = Modifier.fillMaxWidth().testTag("sspi.server"),
		)
		Spacer(Modifier.height(12.dp))
		OutlinedTextField(
			value = token,
			onValueChange = { token = it },
			label = { Text("Pairing token") },
			singleLine = true,
			modifier = Modifier.fillMaxWidth().testTag("sspi.token"),
		)
		Spacer(Modifier.height(20.dp))
		Button(
			onClick = {
				val s = server.trim().trimEnd('/')
				val t = token.trim()
				if (!s.startsWith("http") || t.isEmpty()) {
					error = "need a server URL and the token"
				} else {
					onPair(s, t)
				}
			},
			modifier = Modifier.fillMaxWidth().testTag("sspi.connect"),
		) {
			Text("Connect")
		}
		error?.let {
			Spacer(Modifier.height(12.dp))
			Text(it, color = Rec, fontSize = 13.sp)
		}
	}
}

typealias ClientFactory = (
	serverUrl: String,
	token: String,
	onEvent: (ServerEvent) -> Unit,
	onConnection: (Boolean) -> Unit,
) -> SspiConnection

@Composable
fun ChatScreen(
	server: String,
	token: String,
	onDisconnect: () -> Unit,
	clientFactory: ClientFactory = ::sspiClientFactory,
) {
	val haptics = LocalHapticFeedback.current
	val messages = remember { mutableStateListOf<Msg>() }
	var connected by remember { mutableStateOf(false) }
	var agentState by remember { mutableStateOf("starting") }
	var toolLabel by remember { mutableStateOf<String?>(null) }
	var notice by remember { mutableStateOf<String?>(null) }
	var recording by remember { mutableStateOf(false) }
	var level by remember { mutableIntStateOf(0) }
	var input by remember { mutableStateOf("") }
	var micGranted by remember { mutableStateOf(false) }
	var pendingVoiceId by remember { mutableStateOf<String?>(null) }

	val chunks = remember { mutableListOf<ShortArray>() }
	val keepRecording = remember { AtomicBoolean(false) }

	val client = remember {
		clientFactory(
			server,
			token,
			{ evt ->
				when (evt) {
					is ServerEvent.HelloOk -> {
						agentState = evt.agent.state
						messages.clear()
						messages.addAll(evt.history.map { Msg(it.id, it.role, it.text, it.source) })
					}
					is ServerEvent.HelloFail -> {
						notice = evt.error
						onDisconnect() // bad token → back to pairing instead of endless "connecting…"
					}
					is ServerEvent.Transcript -> {
						pendingVoiceId = evt.id
						messages.add(Msg(evt.id, "user", evt.text, "voice"))
					}
					is ServerEvent.UserMessage -> {
						val idx = messages.indexOfFirst { it.id == evt.id }
						if (idx >= 0) messages[idx] = Msg(evt.id, "user", evt.text, evt.source)
						else messages.add(Msg(evt.id, "user", evt.text, evt.source))
						pendingVoiceId = null
					}
					is ServerEvent.AssistantDelta -> {
						val idx = messages.indexOfLast { it.id == evt.id }
						if (idx >= 0) {
							val m = messages[idx]
							messages[idx] = m.copy(text = m.text + evt.delta)
						} else {
							messages.add(Msg(evt.id, "assistant", evt.delta, null))
						}
					}
					is ServerEvent.AssistantFinal -> {
						val idx = messages.indexOfFirst { it.id == evt.id }
						if (idx >= 0) messages[idx] = Msg(evt.id, "assistant", evt.text, null)
						else messages.add(Msg(evt.id, "assistant", evt.text, null))
					}
					is ServerEvent.AgentStateEvt -> {
						agentState = evt.state
						toolLabel = if (evt.state == "tool") evt.toolName else null
					}
					is ServerEvent.ToolEvent -> toolLabel = if (evt.phase == "start") evt.toolName else null
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
			startRecording() // finger already released → tap once more to stop & send
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

	val statusText = when {
		!connected -> "connecting…"
		agentState == "tool" -> "running ${toolLabel ?: "tool"}…"
		agentState == "thinking" -> "thinking…"
		agentState == "streaming" -> "writing…"
		agentState == "starting" -> "agent starting…"
		else -> "one session · every screen"
	}

	Column(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
		// header
		Row(
			modifier = Modifier.fillMaxWidth().background(Panel).padding(horizontal = 16.dp, vertical = 14.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Text("sspi ", color = Text0, fontSize = 18.sp)
			Text("**pi", color = Dim, fontSize = 13.sp)
			Spacer(Modifier.weight(1f))
			Text(
				statusText,
				color = if (connected) Dim else Rec,
				fontSize = 12.sp,
				textAlign = TextAlign.End,
			)
			Spacer(Modifier.width(12.dp))
			Text("unpair", color = Dim, fontSize = 12.sp, modifier = Modifier.pointerInput(Unit) {
				detectTapGestures(onTap = { onDisconnect() })
			})
		}

		// conversation
		LazyColumn(
			state = listState,
			modifier = Modifier.weight(1f).fillMaxWidth(),
			contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
			verticalArrangement = Arrangement.spacedBy(10.dp),
		) {
			if (messages.isEmpty()) {
				item {
					Column(Modifier.fillMaxWidth().padding(top = 120.dp), horizontalAlignment = Alignment.CenterHorizontally) {
						Text("Hold the mic and talk to your omni agent.", color = Dim, textAlign = TextAlign.Center)
						Spacer(Modifier.height(6.dp))
						Text("It manages your repos, sessions, and worktrees.", color = Dim, fontSize = 13.sp, textAlign = TextAlign.Center)
					}
				}
			}
			items(messages, key = { it.id }) { m ->
				Box(Modifier.fillMaxWidth()) {
					Bubble(m)
				}
			}
			if (agentState == "thinking" || agentState == "tool") {
				item {
					Box(Modifier.padding(start = 4.dp)) { CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = Accent) }
				}
			}
		}

		// voice-first composer
		Column(
			modifier = Modifier.fillMaxWidth().background(Panel).padding(16.dp),
			horizontalAlignment = Alignment.CenterHorizontally,
		) {
			Box(
				modifier = Modifier
					.size(84.dp)
					.testTag("sspi.mic")
					.clip(CircleShape)
					.background(if (recording) Rec else Color(0xFF22304F))
					.border(3.dp, if (recording) Rec else Line, CircleShape)
					.pointerInput(Unit) {
						detectTapGestures(
							onPress = {
								when {
									recording -> {
										// hold-to-talk: stop and send on release
										tryAwaitRelease()
										stopRecordingAndSend()
									}
									micGranted -> {
										// push to talk: start on press, send on release
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
				Text(if (recording) "■" else "●", color = if (recording) Text0 else Accent, fontSize = 26.sp)
			}
			Spacer(Modifier.height(6.dp))
			Text(
				when {
					recording -> "recording… release to send (${level})"
					else -> "hold to talk"
				},
				color = Dim,
				fontSize = 12.sp,
			)
			Spacer(Modifier.height(10.dp))
			Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
				OutlinedTextField(
					value = input,
					onValueChange = { input = it },
					placeholder = { Text("or type…", color = Dim) },
					singleLine = true,
					modifier = Modifier.weight(1f).testTag("sspi.composer"),
				)
				Spacer(Modifier.width(8.dp))
				Button(
					onClick = {
						val t = input.trim()
						if (t.isNotEmpty()) {
							client.sendChat(t)
							input = ""
						}
					},
					enabled = input.isNotBlank(),
					colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Bg),
					modifier = Modifier.testTag("sspi.send"),
				) {
					Text("send")
				}
			}
		}
	}

	notice?.let { n ->
		Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
			Surface(
				color = Color(0xFF2A1518),
				shape = RoundedCornerShape(12.dp),
				border = androidx.compose.foundation.BorderStroke(1.dp, Rec),
				modifier = Modifier.padding(bottom = 140.dp).widthIn(max = 340.dp),
			) {
				Text(n, color = Color(0xFFFFB4B4), fontSize = 13.sp, modifier = Modifier.padding(12.dp))
			}
		}
	}
}

@Composable
fun Bubble(m: Msg) {
	Row(horizontalArrangement = if (m.role == "user") Arrangement.End else Arrangement.Start, modifier = Modifier.fillMaxWidth()) {
		if (m.role == "user") Spacer(Modifier.weight(1f))
		Text(
			text = (if (m.source == "voice") "🎤 " else "") + if (m.text.isEmpty()) "…" else m.text,
			color = Text0,
			fontSize = 15.sp,
			modifier = Modifier
				.widthIn(max = 320.dp)
				.clip(
					RoundedCornerShape(
						topStart = 16.dp,
						topEnd = 16.dp,
						bottomStart = if (m.role == "user") 16.dp else 4.dp,
						bottomEnd = if (m.role == "user") 4.dp else 16.dp,
					),
				)
				.background(if (m.role == "user") UserBubble else Panel)
				.border(1.dp, if (m.role == "user") UserBubble else Line, RoundedCornerShape(16.dp))
				.padding(horizontal = 14.dp, vertical = 10.dp),
		)
		if (m.role == "assistant") Spacer(Modifier.weight(1f))
	}
}
