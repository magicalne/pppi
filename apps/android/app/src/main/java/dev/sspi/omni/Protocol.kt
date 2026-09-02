package dev.sspi.omni

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// Wire protocol mirroring packages/protocol (TypeScript side).

@Serializable
sealed class ServerEvent {

	@Serializable
	@SerialName("hello_ok")
	data class HelloOk(
		val agent: AgentInfo,
		val history: List<ChatEntry> = emptyList(),
	) : ServerEvent()

	@Serializable
	@SerialName("hello_fail")
	data class HelloFail(val error: String) : ServerEvent()

	@Serializable
	@SerialName("agent_info")
	data class AgentInfoEvt(val agent: AgentInfo) : ServerEvent()

	@Serializable
	@SerialName("agent_state")
	data class AgentStateEvt(val state: String, val toolName: String? = null) : ServerEvent()

	@Serializable
	@SerialName("user_message")
	data class UserMessage(val id: String, val text: String, val source: String = "text") : ServerEvent()

	@Serializable
	@SerialName("transcript")
	data class Transcript(val id: String, val text: String) : ServerEvent()

	@Serializable
	@SerialName("assistant_delta")
	data class AssistantDelta(val id: String, val delta: String) : ServerEvent()

	@Serializable
	@SerialName("assistant_final")
	data class AssistantFinal(val id: String, val text: String) : ServerEvent()

	@Serializable
	@SerialName("tool_event")
	data class ToolEvent(val toolName: String, val phase: String) : ServerEvent()

	@Serializable
	@SerialName("agent_notify")
	data class AgentNotify(val level: String = "info", val message: String) : ServerEvent()

	@Serializable
	@SerialName("error")
	data class ErrorEvt(val message: String) : ServerEvent()
}

@Serializable
data class AgentInfo(
	val model: String? = null,
	val sessionName: String? = null,
	val sessionId: String? = null,
	val state: String = "starting",
)

@Serializable
data class ChatEntry(
	val id: String,
	val role: String,
	val text: String,
	val source: String? = null,
	val ts: Long = 0,
)

@Serializable
sealed class ClientMessage {

	@Serializable
	@SerialName("hello")
	data class Hello(val token: String, val client: String = "android") : ClientMessage()

	@Serializable
	@SerialName("chat")
	data class Chat(val text: String, val source: String = "text") : ClientMessage()

	@Serializable
	@SerialName("abort")
	class Abort : ClientMessage()
}

val protocolJson = Json {
	ignoreUnknownKeys = true
	classDiscriminator = "type"
}
