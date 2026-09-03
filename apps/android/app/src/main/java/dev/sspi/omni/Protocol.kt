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
	data class UserMessage(val id: String, val text: String, val source: String = "text", val target: String? = null) : ServerEvent()

	@Serializable
	@SerialName("transcript")
	data class Transcript(val id: String, val text: String, val target: String? = null) : ServerEvent()

	@Serializable
	@SerialName("assistant_delta")
	data class AssistantDelta(val id: String, val delta: String, val target: String? = null, val profileId: String? = null) : ServerEvent()

	@Serializable
	@SerialName("assistant_final")
	data class AssistantFinal(val id: String, val text: String, val target: String? = null, val profileId: String? = null) : ServerEvent()

	@Serializable
	@SerialName("tool_event")
	data class ToolEvent(val toolName: String, val phase: String, val label: String? = null) : ServerEvent()

	@Serializable
	@SerialName("agent_notify")
	data class AgentNotify(val level: String = "info", val message: String) : ServerEvent()

	@Serializable
	@SerialName("error")
	data class ErrorEvt(val message: String, val target: String? = null) : ServerEvent()
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
	val target: String? = null,
	val profileId: String? = null,
)

@Serializable
sealed class ClientMessage {

	@Serializable
	@SerialName("hello")
	data class Hello(val token: String, val client: String = "android") : ClientMessage()

	@Serializable
	@SerialName("chat")
	data class Chat(val text: String, val source: String = "text", val target: String? = null) : ClientMessage()

	@Serializable
	@SerialName("abort")
	class Abort : ClientMessage()
}

// ---- GET /api/sessions (mirrors packages/protocol) ----

@Serializable
data class PeerSessionDto(
	val sessionId: String,
	val name: String? = null,
	val state: String = "idle",
	val cwd: String = "",
	val branch: String = "main",
	val worktree: String? = null,
)

@Serializable
data class ProfileDto(
	val id: String,
	val name: String,
	val color: String = "#888888",
	val description: String = "",
)

@Serializable
data class ProjectGroupDto(val name: String, val path: String = "", val sessions: List<PeerSessionDto> = emptyList())

@Serializable
data class SessionsResponseDto(
	val omniSessionId: String = "omni",
	val projects: List<ProjectGroupDto> = emptyList(),
	val others: List<PeerSessionDto> = emptyList(),
	val profiles: Map<String, ProfileDto> = emptyMap(),
)

// ---- GET /api/pair (mirrors packages/protocol PairInfo) ----

@Serializable
data class PairInfoDto(
	val machine: String = "",
	val port: Int = 8787,
	val token: String = "",
	val ips: List<String> = emptyList(),
	val urls: List<String> = emptyList(),
	val fingerprint: String = "",
)

val protocolJson = Json {
	ignoreUnknownKeys = true
	classDiscriminator = "type"
}
