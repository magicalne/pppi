package dev.sspi.omni

/** Abstraction over the gateway connection so UI tests can inject a fake. */
interface SspiConnection {
	fun connect()
	fun sendChat(text: String, target: String? = null)
	fun abort()
	fun uploadVoice(wav: ByteArray, onDone: (Boolean, String) -> Unit)
	fun close()
}

fun sspiClientFactory(
	serverUrl: String,
	token: String,
	onEvent: (ServerEvent) -> Unit,
	onConnection: (Boolean) -> Unit,
): SspiConnection = SspiClient(serverUrl, token, onEvent, onConnection)
