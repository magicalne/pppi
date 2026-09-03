package dev.sspi.omni

import java.util.concurrent.atomic.AtomicBoolean

/** Scriptable [SspiConnection] for UI tests: records calls, replays events. */
class FakeSspiConnection : SspiConnection {

	lateinit var onEvent: (ServerEvent) -> Unit
	lateinit var onConnection: (Boolean) -> Unit
	val chats = mutableListOf<String>()
	val uploads = mutableListOf<ByteArray>()
	var closed = false
	var connectCount = 0
	val disconnectNever = AtomicBoolean(false)

	fun bind(onEvent: (ServerEvent) -> Unit, onConnection: (Boolean) -> Unit) {
		this.onEvent = onEvent
		this.onConnection = onConnection
	}

	override fun connect() {
		connectCount++
	}

	override fun sendChat(text: String, target: String?) {
		chats.add(text)
	}

	override fun abort() = Unit

	override fun uploadVoice(wav: ByteArray, onDone: (Boolean, String) -> Unit) {
		uploads.add(wav)
		onDone(true, "{}")
	}

	override fun close() {
		closed = true
	}

	/** Replay a server event into the app (runs on the test/UI thread). */
	fun emit(event: ServerEvent) {
		onEvent(event)
	}
}
