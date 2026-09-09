package dev.pppi.omni

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okio.ByteString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Client for the /voice websocket: continuous 16 kHz mono PCM16 uplink,
 * JSON control events and binary TTS audio downlink. The pairing token is
 * the only credential. The server owns VAD + endpointing, so the client
 * just streams and reacts.
 *
 * Before hello_ok the server may send __voice_boot__ control frames (model
 * loading progress); each one extends the handshake deadline — a warming
 * server may legitimately take a while — and lands in [onBoot] so the UI
 * can show real progress instead of a silent wait.
 */
class VoiceClient(
	private var serverUrl: String,
	private val token: String,
	private val onEvent: (VoiceServerEvent) -> Unit,
	private val onAudio: (ByteString) -> Unit,
	private val onGone: () -> Unit,
	private val onBoot: (component: String, stage: String, reason: String?) -> Unit = { _, _, _ -> },
) {

	private val http = OkHttpClient.Builder()
		.connectTimeout(5, TimeUnit.SECONDS)
		.readTimeout(0, TimeUnit.MILLISECONDS)
		// app-level pings below bound dead-server detection; this is the backstop
		.pingInterval(10, TimeUnit.SECONDS)
		.build()

	private var ws: WebSocket? = null
	private var pinger: Thread? = null
	var live: Boolean = false
		private set

	/** Connect + handshake; suspends the calling thread until hello_ok/hello_fail. */
	@Throws(Exception::class)
	fun start() {
		val url = serverUrl.trimEnd('/').replaceFirst("http", "ws") + "/voice"
		val request = Request.Builder().url(url).build()
		val latch = java.util.concurrent.CountDownLatch(1)
		var failure: Throwable? = null
		// a quiet server must fail fast; boot frames keep pushing this out
		var deadline = System.currentTimeMillis() + 12_000
		val json = Json { ignoreUnknownKeys = true }
		ws = http.newWebSocket(
			request,
			object : WebSocketListener() {
				override fun onOpen(webSocket: WebSocket, response: Response) {
					webSocket.send(VoiceClientMessages.hello(token))
				}

				override fun onMessage(webSocket: WebSocket, text: String) {
					try {
						if (text.contains("__voice_boot__")) {
							val obj = json.parseToJsonElement(text).jsonObject
							val stage = obj["stage"]?.jsonPrimitive?.content ?: "loading"
							val component = obj["component"]?.jsonPrimitive?.content
							val reason = obj["reason"]?.jsonPrimitive?.content
							if (stage != "ready") deadline = System.currentTimeMillis() + 90_000
							onBoot(component ?: "voice", stage, reason)
							return
						}
						val evt = json.decodeFromString(VoiceServerEvent.serializer(), text)
						when (evt) {
							is VoiceServerEvent.VoiceHelloOk -> {
								live = true
								startPinger()
								latch.countDown()
							}
							is VoiceServerEvent.VoiceHelloFail -> {
								failure = Exception(evt.error)
								latch.countDown()
							}
							else -> if (live) onEvent(evt)
						}
					} catch (_: Exception) {
						// malformed — ignore
					}
				}

				override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
					if (live) onAudio(bytes)
				}

				override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
					live = false
					if (latch.count > 0) {
						failure = t
						latch.countDown()
					} else onGone()
				}

				override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
					live = false
					if (latch.count > 0) latch.countDown() else onGone()
				}
			},
		)
		while (true) {
			val remaining = deadline - System.currentTimeMillis()
			if (remaining <= 0) break
			if (latch.await(minOf(remaining, 2_000), TimeUnit.MILLISECONDS)) break
		}
		failure?.let { throw it }
		if (!live) throw Exception("couldn't reach the voice service — is /omni running on the Mac?")
	}

	fun sendAudio(pcm16: ByteArray) {
		if (live) ws?.send(pcm16.toByteString())
	}

	/**
	 * A silent zombie socket (server died without a clean FIN reaching the
	 * reader) can sit "live" for a long time — writing every 10 s forces the
	 * failure to surface so the UI can leave "listening" honestly. The server
	 * ignores unknown message types.
	 */
	private fun startPinger() {
		pinger = thread(name = "pppi-ping", isDaemon = true) {
			while (live) {
				Thread.sleep(10_000)
				if (!live) break
				if (ws?.send("{\"type\":\"ping\"}") != true) break
			}
		}
	}

	fun interrupt() {
		if (live) ws?.send(VoiceClientMessages.interrupt())
	}

	fun playbackDone() {
		if (live) ws?.send(VoiceClientMessages.playbackDone())
	}

	fun close() {
		live = false
		ws?.close(1000, "bye")
		ws = null
	}
}
