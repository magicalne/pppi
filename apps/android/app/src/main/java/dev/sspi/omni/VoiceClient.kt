package dev.sspi.omni

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

/**
 * Client for the /voice websocket: continuous 16 kHz mono PCM16 uplink,
 * JSON control events and binary TTS audio downlink. The pairing token is
 * the only credential. The server owns VAD + endpointing, so the client
 * just streams and reacts.
 */
class VoiceClient(
	private var serverUrl: String,
	private val token: String,
	private val onEvent: (VoiceServerEvent) -> Unit,
	private val onAudio: (ByteString) -> Unit,
	private val onGone: () -> Unit,
) {

	private val http = OkHttpClient.Builder()
		.connectTimeout(5, TimeUnit.SECONDS)
		.readTimeout(0, TimeUnit.MILLISECONDS)
		.pingInterval(30, TimeUnit.SECONDS)
		.build()

	private var ws: WebSocket? = null
	var live: Boolean = false
		private set

	/** Connect + handshake; suspends the calling thread until hello_ok/hello_fail. */
	@Throws(Exception::class)
	fun start() {
		val url = serverUrl.trimEnd('/').replaceFirst("http", "ws") + "/voice"
		val request = Request.Builder().url(url).build()
		val latch = java.util.concurrent.CountDownLatch(1)
		var failure: Throwable? = null
		ws = http.newWebSocket(
			request,
			object : WebSocketListener() {
				override fun onOpen(webSocket: WebSocket, response: Response) {
					webSocket.send(VoiceClientMessages.hello(token))
				}

				override fun onMessage(webSocket: WebSocket, text: String) {
					try {
						val evt = protocolJson.decodeFromString(VoiceServerEvent.serializer(), text)
						when (evt) {
							is VoiceServerEvent.VoiceHelloOk -> {
								live = true
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
		latch.await(12, TimeUnit.SECONDS)
		failure?.let { throw it }
		if (!live) throw Exception("voice handshake failed")
	}

	fun sendAudio(pcm16: ByteArray) {
		if (live) ws?.send(pcm16.toByteString())
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
