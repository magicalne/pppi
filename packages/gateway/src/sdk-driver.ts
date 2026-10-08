// In-process SDK agent driver: hosts the omni conversation directly in this
// process via pi's documented embedding API (createAgentSession, see pi
// docs/sdk.md) instead of spawning a `pi --mode rpc` child. Third AgentPort
// implementation next to RpcAgentDriver (child process) and the pi-ext
// ExtensionAgentDriver (the host session itself).
//
// Spike per docs/plan/pi-1.0-and-durable.md phase 2: no child to spawn or
// restart, typed events instead of JSONL — at the cost of process isolation
// and pi's built-in codemode/MCP extensions (not loaded here; pass them via
// a custom `create` if needed).

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentStatus, ContextInfo, ModelInfo } from "@pppi/protocol";
import {
	type AgentSnapshot,
	type AgentState,
	textFromAssistant,
	textFromUser,
	toModelInfo,
	toolLabel,
} from "./agent.ts";

/**
 * The slice of pi's AgentSession this driver touches. Structural, so tests
 * can stub it and the real AgentSession satisfies it as-is.
 */
export interface SdkSessionLike {
	subscribe(listener: (event: any) => void): () => void;
	dispose(): void;
	get isStreaming(): boolean;
	get isCompacting(): boolean;
	get model(): unknown;
	get thinkingLevel(): string;
	getAvailableThinkingLevels(): string[];
	get sessionId(): string;
	get sessionName(): string | undefined;
	get messages(): Array<Record<string, any>>;
	getContextUsage(): ContextInfo | undefined;
	get modelRuntime(): { getModel(provider: string, modelId: string): unknown; getAvailable(): Promise<unknown[]> };
	prompt(
		text: string,
		options?: {
			streamingBehavior?: "steer" | "followUp";
			preflightResult?: (disposition: "handled" | "queued" | "started") => void;
		},
	): Promise<void>;
	steer(text: string): Promise<"handled" | "queued">;
	followUp(text: string): Promise<"handled" | "queued">;
	abort(): Promise<void>;
	compact(customInstructions?: string): Promise<unknown>;
	setModel(model: unknown): Promise<void>;
	setThinkingLevel(level: string): void;
}

export type SdkDriverEvents = {
	info: (info: AgentSnapshot) => void;
	state: (state: string, toolName?: string) => void;
	status: (status: AgentStatus) => void;
	"assistant-delta": (id: string, delta: string) => void;
	"assistant-final": (id: string, text: string) => void;
	tool: (toolName: string, phase: "start" | "end", label?: string) => void;
	notify: (level: "info" | "warning" | "error", message: string) => void;
	error: (message: string) => void;
	ready: () => void;
};

/** Where a session comes from — overridable so tests never load real pi. */
export type SdkSessionFactory = (opts: { cwd: string }) => Promise<{ session: SdkSessionLike }>;

const defaultFactory: SdkSessionFactory = async ({ cwd }) => {
	// dynamic import: hosts that never pick the sdk driver don't load pi
	const mod = (await import("@earendil-works/pi-coding-agent")) as {
		createAgentSession: (opts: Record<string, unknown>) => Promise<{ session: unknown }>;
	};
	const made = await mod.createAgentSession({ cwd });
	return { session: made.session as SdkSessionLike };
};

export class SdkAgentDriver extends EventEmitter {
	private session: SdkSessionLike | null = null;
	private detach: (() => void) | null = null;
	private disposed = false;
	private isStreaming = false;
	private assistantId: string | null = null;
	private _state: AgentState = "starting";
	private snapshot: AgentSnapshot = { model: null, thinkingLevel: "off", thinkingLevels: [] };
	private context: ContextInfo | null = null;

	readonly cwd: string;
	private readonly createSession: SdkSessionFactory;

	constructor(opts: { cwd: string; create?: SdkSessionFactory }) {
		super();
		this.cwd = opts.cwd;
		this.createSession = opts.create ?? defaultFactory;
	}

	get state(): AgentState {
		return this._state;
	}

	get info(): AgentSnapshot {
		return this.snapshot;
	}

	get status(): AgentStatus {
		return {
			model: this.snapshot.model,
			thinkingLevel: this.snapshot.thinkingLevel,
			thinkingLevels: this.snapshot.thinkingLevels,
			context: this.context,
		};
	}

	start(): void {
		if (this.disposed) return;
		void this.boot().catch((err) => this.emit("error", `sdk session failed to start: ${String(err)}`));
	}

	private async boot(): Promise<void> {
		const { session } = await this.createSession({ cwd: this.cwd });
		if (this.disposed) {
			session.dispose();
			return;
		}
		this.session = session;
		this.attach(session);
		this.refreshStatus();
		this.setState("idle");
		this.emit("ready");
	}

	/** Translate the session's event bus into the AgentPort event vocabulary. */
	private attach(session: SdkSessionLike): void {
		this.detach = session.subscribe((ev: any) => {
			switch (ev?.type) {
				case "agent_start":
					this.isStreaming = true;
					this.assistantId = null;
					this.setState("thinking");
					break;
				case "agent_end":
					this.isStreaming = false;
					break;
				case "agent_settled":
					this.isStreaming = false;
					this.setState("idle");
					this.refreshStatus();
					break;
				case "compaction_start":
					this.setState("compacting");
					break;
				case "compaction_end":
					// pi's RPC driver treats the compaction edge as idle; the next
					// turn event corrects if a run is still going
					this.setState("idle");
					this.refreshStatus();
					break;
				case "tool_execution_start":
					this.setState("tool");
					this.emit("tool", ev.toolName, "start", toolLabel(ev.toolName, ev.args));
					break;
				case "tool_execution_end":
					this.emit("tool", ev.toolName, "end");
					this.setState("streaming");
					break;
				case "message_update": {
					const delta = ev.assistantMessageEvent;
					if (delta?.type !== "text_delta") break;
					if (!this.assistantId) this.assistantId = randomUUID();
					this.setState("streaming");
					this.emit("assistant-delta", this.assistantId, delta.delta ?? "");
					break;
				}
				case "message_end": {
					const msg = ev.message;
					if (msg?.role !== "assistant") break;
					if (msg.stopReason === "error") {
						this.emit("notify", "error", `agent error: ${msg.errorMessage ?? "unknown"}`);
					}
					const text = textFromAssistant(msg);
					if (text) this.emit("assistant-final", this.assistantId ?? randomUUID(), text);
					this.assistantId = null;
					break;
				}
				case "thinking_level_changed":
					this.refreshStatus();
					break;
				default:
					break;
			}
		});
	}

	private setState(s: AgentState, toolName?: string): void {
		if (this._state === s) return;
		this._state = s;
		this.emit("state", s, toolName);
	}

	private refreshStatus(): void {
		const session = this.session;
		if (!session) return;
		this.snapshot = {
			model: toModelInfo(session.model),
			thinkingLevel: session.thinkingLevel ?? "off",
			thinkingLevels: session.getAvailableThinkingLevels(),
			sessionId: session.sessionId,
			sessionName: session.sessionName,
		};
		this.context = session.getContextUsage() ?? null;
		this.emit("status", this.status);
	}

	/** Send a user message; `deliver: "steer"` injects into the running turn. */
	async prompt(text: string, opts?: { deliver?: "followUp" | "steer" }): Promise<void> {
		const session = this.session;
		if (!session) throw new Error("sdk session not started");
		// pi executes extension commands (disposition "handled") even while
		// streaming, and steer()/followUp() throw on commands — so everything
		// goes through prompt(), same as the RPC driver's prompt command.
		let disposition: "handled" | "queued" | "started" | undefined;
		await session.prompt(text, {
			...(session.isStreaming ? { streamingBehavior: opts?.deliver === "steer" ? "steer" : "followUp" } : {}),
			preflightResult: (d) => {
				disposition = d;
			},
		});
		if (disposition === "handled") this.emit("notify", "info", "handled by an extension — no agent turn");
	}

	async abort(): Promise<void> {
		await this.session?.abort();
	}

	async compact(): Promise<void> {
		if (!this.session) throw new Error("sdk session not started");
		await this.session.compact();
	}

	/** Reset to a fresh session: replace the session object in place. */
	async newSession(): Promise<void> {
		if (!this.session) throw new Error("sdk session not started");
		const old = this.session;
		this.session = null;
		this.detach?.();
		old.dispose();
		await this.boot();
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		const session = this.session;
		if (!session) throw new Error("sdk session not started");
		const model = session.modelRuntime.getModel(provider, modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		await session.setModel(model);
		this.refreshStatus();
		this.emit("info", this.info);
	}

	async setThinkingLevel(level: string): Promise<void> {
		if (!this.session) throw new Error("sdk session not started");
		this.session.setThinkingLevel(level);
		this.refreshStatus();
	}

	async availableModels(): Promise<ModelInfo[]> {
		const session = this.session;
		if (!session) return [];
		const models = await session.modelRuntime.getAvailable();
		return models.map((m) => toModelInfo(m)).filter((m): m is ModelInfo => m !== null);
	}

	/** A page of conversation history, newest-last (same shape as RpcAgentDriver). */
	async history(opts?: { before?: number; limit?: number }): Promise<{
		entries: Array<{ role: "user" | "assistant"; text: string; ts: number }>;
		hasMore: boolean;
	}> {
		const session = this.session;
		if (!session) return { entries: [], hasMore: false };
		const all: Array<{ role: "user" | "assistant"; text: string; ts: number }> = [];
		for (const m of session.messages) {
			if (m?.role !== "user" && m?.role !== "assistant") continue;
			const text = m.role === "user" ? textFromUser(m) : textFromAssistant(m);
			if (!text.trim()) continue;
			const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();
			all.push({ role: m.role, text, ts });
		}
		const older = opts?.before === undefined ? all : all.filter((e) => e.ts < (opts.before ?? 0));
		const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
		return { entries: older.slice(-limit), hasMore: older.length > limit };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.detach?.();
		this.session?.dispose();
		this.session = null;
	}
}
