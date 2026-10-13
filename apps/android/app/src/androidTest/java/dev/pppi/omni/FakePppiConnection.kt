package dev.pppi.omni

import java.util.concurrent.atomic.AtomicBoolean

/** Scriptable [PppiConnection] for UI tests: records calls, replays events. */
class FakePppiConnection : PppiConnection {

	lateinit var onEvent: (ServerEvent) -> Unit
	lateinit var onConnection: (Boolean) -> Unit
	val chats = mutableListOf<String>()
	val uploads = mutableListOf<ByteArray>()
	val modelSets = mutableListOf<Pair<String, String>>()
	val thinkingLevels = mutableListOf<String>()
	val historyLoads = mutableListOf<Pair<Long, Int>>()
	var listModelsCount = 0
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

	override fun setModel(provider: String, modelId: String) {
		modelSets.add(provider to modelId)
	}

	override fun setThinkingLevel(level: String) {
		thinkingLevels.add(level)
	}

	override fun listModels() {
		listModelsCount++
	}

	override fun loadHistory(before: Long, limit: Int) {
		historyLoads.add(before to limit)
	}

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
