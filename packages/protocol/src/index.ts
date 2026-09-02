// Wire protocol between sspi clients (web / android) and the sspi gateway server.
// One omni agent session; every client mirrors the same conversation.

export type AgentState = "starting" | "idle" | "thinking" | "tool" | "streaming";

export type MessageSource = "voice" | "text";

export type AgentInfo = {
	model: string | null;
	sessionName?: string;
	sessionId?: string;
	state: AgentState;
};

export type ChatEntry = {
	id: string;
	role: "user" | "assistant";
	text: string;
	source?: MessageSource;
	ts: number;
};

// ---------------------------------------------------------------- client → server

export type ClientMessage =
	| { type: "hello"; token: string; client: "web" | "android" | "test" }
	| { type: "chat"; text: string; source?: MessageSource }
	| { type: "abort" };

// ---------------------------------------------------------------- server → client

export type ServerEvent =
	| { type: "hello_ok"; agent: AgentInfo; history: ChatEntry[] }
	| { type: "hello_fail"; error: string }
	| { type: "agent_info"; agent: AgentInfo }
	| { type: "agent_state"; state: AgentState; toolName?: string }
	| { type: "user_message"; id: string; text: string; source: MessageSource }
	| { type: "transcript"; id: string; text: string }
	| { type: "assistant_delta"; id: string; delta: string }
	| { type: "assistant_final"; id: string; text: string }
	| { type: "tool_event"; toolName: string; phase: "start" | "end"; label?: string }
	| { type: "agent_notify"; level: "info" | "warning" | "error"; message: string }
	| { type: "error"; message: string };

export const VOICE_MIME = "audio/wav";

/** Recommended local ASR models (same catalog pi-transcribe uses). */
export const RECOMMENDED_STT_MODEL = "parakeet-unified-en-0.6b";
