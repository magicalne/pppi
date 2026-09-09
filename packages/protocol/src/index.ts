// Wire protocol between pppi clients (web / android) and the pppi gateway server.
// One omni agent session; every client mirrors the same conversation.
// v2: targets (omni default, or a peer session id) + rich tool labels.
// v3: session profiles (name/color/description), reply attribution via
//     profileId, and machine pairing info (multi-machine connections).
// v4: interactive voice mode (ws /voice) — hands-free conversation with
//     streaming STT partials, spoken replies (local TTS) and barge-in.
// v5: status bar — context usage, current model, thinking effort; clients can
//     switch model / thinking level and list the enabled models (pi settings).
//     Also: paged history — clients cache the recent window and pull older
//     pages only when the user scrolls to the top.

export type AgentState = "starting" | "idle" | "thinking" | "tool" | "streaming" | "compacting";

export type MessageSource = "voice" | "text";

/** undefined/"omni" target = the omni agent itself; otherwise a peer session id. */
export type Target = string | undefined;

/** Identity of a pi session. Color tints that agent's replies; description is agent-readable. */
export type Profile = {
	id: string; // session id the profile belongs to
	name: string;
	color: string; // hex, e.g. "#e8b14a"
	description: string;
};

/** Pairing facts for one machine (gateway). `urls` are the LAN addresses clients can pair against. */
export type PairInfo = {
	machine: string;
	port: number;
	token: string;
	ips: string[];
	urls: string[];
	/** short hash of the token so a human can eyeball-verify a QR/link */
	fingerprint: string;
};

export type AgentInfo = {
	model: string | null;
	sessionName?: string;
	sessionId?: string;
	state: AgentState;
};

/** A model the omni pi session can run, as pi reports it. */
export type ModelInfo = {
	provider: string;
	id: string;
	/** display name, e.g. "Claude Opus 4.8" */
	name: string;
	/** false → thinking is not supported at all (brain pinned dim) */
	reasoning: boolean;
	contextWindow: number;
	/** pi's canonical level → provider-native value; null marks a level unsupported for this model */
	thinkingLevelMap: Record<string, string | null>;
};

/** Context usage of the omni session. `tokens`/`percent` are null briefly after compaction. */
export type ContextInfo = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
};

/** Full status-bar snapshot: everything the bar renders, so clients are dumb mirrors. */
export type AgentStatus = {
	model: ModelInfo | null;
	/** pi canonical level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" */
	thinkingLevel: string;
	/** levels the current model supports, canonical order — the slider's stops */
	thinkingLevels: string[];
	context: ContextInfo | null;
};

export type ChatEntry = {
	id: string;
	role: "user" | "assistant";
	text: string;
	source?: MessageSource;
	ts: number;
	target?: Target;
	/** set when the message is attributed to a profiled agent (delegated reply) */
	profileId?: string;
};

// ---------------------------------------------------------------- client → server

export type ClientMessage =
	| { type: "hello"; token: string; client: "web" | "android" | "test" }
	| { type: "chat"; text: string; source?: MessageSource; target?: Target }
	| { type: "abort"; target?: Target }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: string }
	| { type: "list_models" }
	/** page of history strictly older than `before` (ms epoch); server replies history_page */
	| { type: "history"; before: number; limit?: number };

// ---------------------------------------------------------------- server → client

export type ServerEvent =
	| { type: "hello_ok"; agent: AgentInfo; history: ChatEntry[] }
	| { type: "hello_fail"; error: string }
	| { type: "agent_info"; agent: AgentInfo }
	| { type: "agent_state"; state: AgentState; toolName?: string }
	| { type: "user_message"; id: string; text: string; source: MessageSource; target?: Target }
	| { type: "transcript"; id: string; text: string; target?: Target }
	| { type: "assistant_delta"; id: string; delta: string; target?: Target; profileId?: string }
	| { type: "assistant_final"; id: string; text: string; target?: Target; profileId?: string }
	| { type: "tool_event"; toolName: string; phase: "start" | "end"; label?: string }
	| { type: "agent_notify"; level: "info" | "warning" | "error"; message: string }
	| { type: "error"; message: string; target?: Target }
	// interactive voice mode is (no longer) live on this gateway
	| { type: "voice_active"; active: boolean }
	// status bar (v5)
	| { type: "status"; status: AgentStatus }
	| { type: "model_list"; models: ModelInfo[] }
	// the omni session was reset (/new): clients clear their mirrored history
	| { type: "session_new" }
	// paged history: entries older than the requested `before`, newest-last
	| { type: "history_page"; entries: ChatEntry[]; hasMore: boolean };

// ---------------------------------------------------------------- interactive voice (ws /voice)

/** One voice state machine shared by both ends: what the conversation is doing. */
export type VoiceState = "listening" | "thinking" | "speaking";

export type VoiceSttStatus = { ready: true; modelId: string } | { ready: false; reason: string };
export type VoiceTtsStatus = { ready: true; provider: string; voice: string } | { ready: false; reason: string };

/**
 * Client → server on /voice. Binary frames carry raw PCM16 16 kHz mono
 * (~100 ms chunks, streamed continuously while the interactive session is
 * open); text frames carry this JSON control protocol. The SERVER runs silero
 * VAD + endpointing (it owns the models and knows when TTS is playing, so
 * barge-in thresholds are echo-aware) and reports turns via `vad` events.
 */
export type VoiceClientMessage =
	| { type: "hello"; token: string; client: "web" | "android" | "test" }
	| { type: "interrupt" }
	/** the client's speaker went idle — echo-aware barge-in thresholds can relax */
	| { type: "playback_done" };

export type VoiceServerEvent =
	| { type: "voice_hello_ok"; stt: VoiceSttStatus; tts: VoiceTtsStatus }
	| { type: "voice_hello_fail"; error: string }
	| { type: "voice_state"; state: VoiceState }
	| { type: "vad"; speaking: boolean }
	| { type: "stt_partial"; committed: string; tentative: string }
	| { type: "stt_final"; id: string; text: string }
	| { type: "tts_start"; id: string; rate: number }
	| { type: "tts_end"; id: string; interrupted?: boolean }
	| { type: "voice_error"; message: string };

// ---------------------------------------------------------------- session tree (GET /api/sessions)

export type SessionState = "idle" | "busy" | "unreachable";

export type PeerSession = {
	sessionId: string;
	name: string | null;
	state: SessionState;
	cwd: string;
	/** "main" for a project session, the worktree name for a worktree session */
	branch: string;
	worktree: string | null;
};

export type ProjectGroup = {
	name: string;
	path: string;
	sessions: PeerSession[];
};

export type SessionsResponse = {
	omniSessionId: string;
	projects: ProjectGroup[];
	others: PeerSession[];
	/** profiles by session id — explicit (/profile) entries plus derived ones for unnamed sessions */
	profiles: Record<string, Profile>;
};

export const VOICE_MIME = "audio/wav";

/** Recommended local ASR models (same catalog pi-transcribe uses). */
export const RECOMMENDED_STT_MODEL = "parakeet-unified-en-0.6b";
