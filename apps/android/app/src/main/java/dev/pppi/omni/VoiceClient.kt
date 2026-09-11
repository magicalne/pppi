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
					VoiceLog.i(TAG, "ws open → $url")
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
								VoiceLog.i(TAG, "hello ok — stt=${evt.stt} tts=${evt.tts}")
								startPinger()
								latch.countDown()
							}
							is VoiceServerEvent.VoiceHelloFail -> {
								VoiceLog.w(TAG, "hello fail: ${evt.error}")
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
					VoiceLog.e(TAG, "ws failure", t)
					if (latch.count > 0) {
						failure = t
						latch.countDown()
					} else onGone()
				}

				override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
					live = false
					VoiceLog.w(TAG, "ws closed code=$code reason=$reason")
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
		if (!live) throw Exception("couldn't reach the voice service — is /pppi_gateway running on the Mac?")
	}

	fun sendAudio(pcm16: ByteArray) {
		if (live) {
			ws?.send(pcm16.toByteString())
			// uplink telemetry every 10s — mirrors the gateway's mic line, so a
			// starving uplink is visible from BOTH ends of the wire
			val now = System.currentTimeMillis()
			sentBytes += pcm16.size
			if (now - lastUplinkLogAt >= 10_000) {
				val windowS = (now - lastUplinkLogAt) / 1000.0
				VoiceLog.i(TAG, "uplink: ${sentBytes / 2 / 16000.0}s audio in ${"%.1f".format(windowS)}s")
				lastUplinkLogAt = now
			}
		} else {
			droppedWhileDead++
			if (droppedWhileDead == 1 || droppedWhileDead % 100 == 0) {
				VoiceLog.w(TAG, "mic audio dropped — ws not live (dropped $droppedWhileDead chunks)")
			}
		}
	}

	private var sentBytes = 0L
	private var lastUplinkLogAt = 0L
	private var droppedWhileDead = 0

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
		VoiceLog.i(TAG, "ws close (bye)")
		ws?.close(1000, "bye")
		ws = null
	}

	private companion object {
		const val TAG = "vclient"
	}
}
