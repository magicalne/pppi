package dev.sspi.omni

/** Abstraction over the gateway connection so UI tests can inject a fake. */
interface SspiConnection {
	fun connect()
	fun sendChat(text: String, target: String? = null)
	fun abort()
	fun setModel(provider: String, modelId: String)
	fun setThinkingLevel(level: String)
	fun listModels()
	/** pull one page of history strictly older than `before` (ms epoch) */
	fun loadHistory(before: Long, limit: Int = 50)
	fun uploadVoice(wav: ByteArray, onDone: (Boolean, String) -> Unit)
	fun close()
}

fun sspiClientFactory(
	serverUrl: String,
	token: String,
	onEvent: (ServerEvent) -> Unit,
	onConnection: (Boolean) -> Unit,
): SspiConnection = SspiClient(serverUrl, token, onEvent, onConnection)
