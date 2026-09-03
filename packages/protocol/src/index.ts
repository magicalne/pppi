// Wire protocol between sspi clients (web / android) and the sspi gateway server.
// One omni agent session; every client mirrors the same conversation.
// v2: targets (omni default, or a peer session id) + rich tool labels.
// v3: session profiles (name/color/description), reply attribution via
//     profileId, and machine pairing info (multi-machine connections).

export type AgentState = "starting" | "idle" | "thinking" | "tool" | "streaming";

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
	| { type: "abort"; target?: Target };

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
	| { type: "error"; message: string; target?: Target };

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
