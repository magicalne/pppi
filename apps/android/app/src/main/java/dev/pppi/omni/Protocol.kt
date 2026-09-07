package dev.pppi.omni

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

	// ---- status bar (protocol v5) ----

	@Serializable
	@SerialName("status")
	data class StatusEvt(val status: AgentStatusDto) : ServerEvent()

	@Serializable
	@SerialName("model_list")
	data class ModelListEvt(val models: List<ModelInfoDto> = emptyList()) : ServerEvent()

	/** paged history: entries older than the requested `before`, newest-last */
	@Serializable
	@SerialName("history_page")
	data class HistoryPageEvt(val entries: List<ChatEntry> = emptyList(), val hasMore: Boolean = false) : ServerEvent()
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

	@Serializable
	@SerialName("set_model")
	data class SetModel(val provider: String, val modelId: String) : ClientMessage()

	@Serializable
	@SerialName("set_thinking_level")
	data class SetThinkingLevel(val level: String) : ClientMessage()

	@Serializable
	@SerialName("list_models")
	class ListModels : ClientMessage()

	/** page of history strictly older than [before] (ms epoch); server replies HistoryPage */
	@Serializable
	@SerialName("history")
	data class History(val before: Long, val limit: Int = 50) : ClientMessage()
}

// ---- status bar (mirrors packages/protocol v5) ----

/** A model the omni pi session can run, as pi reports it. */
@Serializable
data class ModelInfoDto(
	val provider: String,
	val id: String,
	val name: String,
	val reasoning: Boolean = false,
	val contextWindow: Long = 0,
	/** pi canonical level → provider-native value; null marks a level unsupported for this model */
	val thinkingLevelMap: Map<String, String?> = emptyMap(),
)

@Serializable
data class ContextInfoDto(
	val tokens: Long? = null,
	val contextWindow: Long = 0,
	val percent: Double? = null,
)

/** Full status-bar snapshot: everything the bar renders, so clients are dumb mirrors. */
@Serializable
data class AgentStatusDto(
	val model: ModelInfoDto? = null,
	val thinkingLevel: String = "off",
	val thinkingLevels: List<String> = emptyList(),
	val context: ContextInfoDto? = null,
)

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

// ---- interactive voice (ws /voice, mirrors packages/protocol v4) ----

@Serializable
data class VoiceStatusDto(
	val ready: Boolean = false,
	val modelId: String? = null,
	val reason: String? = null,
	val provider: String? = null,
	val voice: String? = null,
)

@Serializable
sealed class VoiceServerEvent {

	@Serializable
	@SerialName("voice_hello_ok")
	data class VoiceHelloOk(val stt: VoiceStatusDto, val tts: VoiceStatusDto) : VoiceServerEvent()

	@Serializable
	@SerialName("voice_hello_fail")
	data class VoiceHelloFail(val error: String) : VoiceServerEvent()

	@Serializable
	@SerialName("voice_state")
	data class VoiceState(val state: String) : VoiceServerEvent()

	@Serializable
	@SerialName("vad")
	data class Vad(val speaking: Boolean) : VoiceServerEvent()

	@Serializable
	@SerialName("stt_partial")
	data class SttPartial(val committed: String = "", val tentative: String = "") : VoiceServerEvent()

	@Serializable
	@SerialName("stt_final")
	data class SttFinal(val id: String, val text: String) : VoiceServerEvent()

	@Serializable
	@SerialName("tts_start")
	data class TtsStart(val id: String, val rate: Int = 24000) : VoiceServerEvent()

	@Serializable
	@SerialName("tts_end")
	data class TtsEnd(val id: String = "", val interrupted: Boolean = false) : VoiceServerEvent()

	@Serializable
	@SerialName("voice_error")
	data class VoiceError(val message: String) : VoiceServerEvent()
}

/** Voice client → server JSON (we only send these three; audio is binary frames). */
object VoiceClientMessages {
	fun hello(token: String): String =
		"""{"type":"hello","token":"$token","client":"android"}"""

	fun interrupt(): String = """{"type":"interrupt"}"""

	fun playbackDone(): String = """{"type":"playback_done"}"""
}

/** UI-facing turn-taking state, mirroring the web pill. */
enum class VoicePhase { LISTENING, USER_SPEAKING, THINKING, AGENT_SPEAKING }

/**
 * Pure phase reducer so the turn-taking UI logic is unit-testable without
 * Android audio. Mirrors apps/web/src/voice/useVoice.ts.
 */
class VoicePhaseMachine {
	var phase: VoicePhase = VoicePhase.LISTENING
		private set

	/** true when the reducer says local playback must stop right now (barge-in). */
	var stopPlayback: Boolean = false
		private set

	fun onVad(speaking: Boolean): Boolean {
		// barge-in: the user talked over the agent — caller must cut local playback
		val stop = speaking && phase == VoicePhase.AGENT_SPEAKING
		stopPlayback = false // one-shot; the return value carries it
		if (speaking) {
			phase = VoicePhase.USER_SPEAKING
		} else if (phase == VoicePhase.USER_SPEAKING) {
			phase = VoicePhase.LISTENING
		}
		return stop
	}

	fun onServerState(state: String) {
		when (state) {
			"thinking" -> phase = VoicePhase.THINKING
			"speaking" -> phase = VoicePhase.AGENT_SPEAKING
			"listening" -> if (phase != VoicePhase.USER_SPEAKING) phase = VoicePhase.LISTENING
		}
	}

	fun reset() {
		phase = VoicePhase.LISTENING
		stopPlayback = false
	}
}
