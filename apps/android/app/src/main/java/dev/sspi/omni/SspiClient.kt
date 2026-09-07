package dev.sspi.omni

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Single-session client for the sspi gateway: one WebSocket mirroring the
 * omni conversation, plus voice upload over REST. The pairing token is the
 * only credential; everything sensitive stays on the Mac.
 */
class SspiClient(
	private var serverUrl: String,
	private var token: String,
	private val onEvent: (ServerEvent) -> Unit,
	private val onConnection: (Boolean) -> Unit,
) : SspiConnection {

	private val http = OkHttpClient.Builder()
		.connectTimeout(5, TimeUnit.SECONDS)
		.readTimeout(0, TimeUnit.MILLISECONDS) // WebSocket: no read timeout
		// keepalive: without pings a half-open connection (NAT timeout, dead
		// server) looks "connected" forever and never triggers reconnect
		.pingInterval(30, TimeUnit.SECONDS)
		.build()

	private var ws: WebSocket? = null
	private var closedByUser = false
	private var retryDelayMs = 1_000L

	override fun connect() {
		closedByUser = false
		val url = serverUrl.trimEnd('/').replaceFirst("http", "ws") + "/ws"
		val request = Request.Builder().url(url).build()
		ws = http.newWebSocket(
			request,
			object : WebSocketListener() {
				override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
					retryDelayMs = 1_000
					webSocket.send(protocolJson.encodeToString(ClientMessage.serializer(), ClientMessage.Hello(token)))
				}

				override fun onMessage(webSocket: WebSocket, text: String) {
					try {
						val evt = protocolJson.decodeFromString(ServerEvent.serializer(), text)
						if (evt is ServerEvent.HelloOk) onConnection(true)
						if (evt is ServerEvent.HelloFail) onConnection(false)
						onEvent(evt)
					} catch (_: Exception) {
						// ignore malformed lines
					}
				}

				override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
					android.util.Log.w("sspi", "ws failure: ${t.message}")
					onConnection(false)
					scheduleReconnect()
				}

				override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
					onConnection(false)
					scheduleReconnect()
				}
			},
		)
	}

	private fun scheduleReconnect() {
		if (closedByUser) return
	 android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ if (!closedByUser) connect() }, retryDelayMs)
		retryDelayMs = (retryDelayMs * 2).coerceAtMost(15_000)
	}

	override fun sendChat(text: String, target: String?) {
		ws?.send(
			protocolJson.encodeToString(ClientMessage.serializer(), ClientMessage.Chat(text, target = target)),
		)
	}

	override fun abort() {
		ws?.send(protocolJson.encodeToString(ClientMessage.serializer(), ClientMessage.Abort()))
	}

	override fun setModel(provider: String, modelId: String) {
		ws?.send(protocolJson.encodeToString(ClientMessage.serializer(), ClientMessage.SetModel(provider, modelId)))
	}

	override fun setThinkingLevel(level: String) {
		ws?.send(protocolJson.encodeToString(ClientMessage.serializer(), ClientMessage.SetThinkingLevel(level)))
	}

	override fun listModels() {
		ws?.send(protocolJson.encodeToString(ClientMessage.serializer(), ClientMessage.ListModels()))
	}

	override fun loadHistory(before: Long, limit: Int) {
		ws?.send(protocolJson.encodeToString(ClientMessage.serializer(), ClientMessage.History(before, limit)))
	}

	/** Upload a voice recording; the server transcribes locally and prompts the omni agent. */
	override fun uploadVoice(wav: ByteArray, onDone: (Boolean, String) -> Unit) {
		val url = serverUrl.trimEnd('/') + "/api/voice"
		val req = Request.Builder()
			.url(url)
			.header("Authorization", "Bearer $token")
			.post(wav.toRequestBody("audio/wav".toMediaType()))
			.build()
		http.newCall(req).enqueue(
			object : okhttp3.Callback {
				override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
					onDone(false, e.message ?: "network error")
				}

				override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
					response.use {
						val body = it.body?.string() ?: ""
						if (it.isSuccessful) onDone(true, body)
						else {
							val msg = Regex("\"error\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1) ?: "HTTP ${it.code}"
							onDone(false, msg)
						}
					}
				}
			},
		)
	}

	override fun close() {
		closedByUser = true
		ws?.close(1000, "bye")
		ws = null
	}
}
