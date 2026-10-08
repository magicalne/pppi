// Durable omni agent driver: AgentPort #4 — the omni conversation hosted
// in-process on pi-durable (docs/plan/durable-omni-pilot.md). Next to the RPC
// child, the extension driver, and the SDK driver.
//
// What this buys over the RPC child: the omni's turns are durable. A gateway
// restart mid-turn reopens the storage, resume() replays the run from its last
// checkpoint, and the turn completes — the omni is the one pppi agent that
// dies with the gateway today.
//
// What it gives up (accepted pilot loss): pi's built-in extensions (MCP,
// codemode), skills, and the extension-UI dialog surface ("waiting"). The
// omni's own tools are ported as a pi-durable extension (./durable-omni.ts);
// repo sessions are untouched.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Context } from "@earendil-works/chord";
import type { ContextInfo, ModelInfo } from "@pppi/protocol";
import type { AgentSnapshot, AgentState } from "../agent.ts";
import { textFromAssistant, textFromUser, toModelInfo, toolLabel } from "../agent.ts";

/** One entry of the active transcript (the structural slice we read). */
type EntryLike = {
	id: string;
	kind: string;
	model?: ReadonlyArray<Record<string, any>>;
};

/** What the driver needs of a pi-durable conversation. */
export interface DurableConversationSlice {
	readonly id: string;
	submit(
		submission: {
			type: "input";
			content: string;
			requestId: string;
			whenBusy?: "steer";
		},
		context: Context,
	): Promise<unknown>;
	reset(handoff: string | undefined, context: Context): Promise<void>;
	compact(instructions: string | undefined, context: Context): Promise<unknown>;
	abort(context: Context): Promise<void>;
	configure(
		change: {
			model?: { provider: string; modelId: string } | null;
			thinkingLevel?: string | null;
		},
		context: Context,
	): Promise<void>;
	agent(context: Context): Promise<{ model?: { provider: string; modelId: string }; thinkingLevel?: string }>;
	viewState(context: Context): Promise<{ value: { entries: readonly EntryLike[] } }>;
}

/** What the driver needs of pi-ai `Models` (satisfied by ModelRuntime too). */
export interface DurableModelsSlice {
	getModel(provider: string, id: string): Record<string, any> | undefined;
	getAvailable(): Promise<readonly Record<string, any>[]>;
}

/** The assembled durable omni, produced by a factory (boot.ts in prod, tests build their own). */
export type DurableOmni = {
	harness: {
		usage(context: Context): Promise<{
			models?: Record<string, { input?: number; output?: number }> | Record<string, never>;
		}>;
		close(context: Context): Promise<void>;
	};
	conversation: DurableConversationSlice;
	models: DurableModelsSlice;
	/** A started `watchEvents` stream over the conversation. */
	events: {
		snapshot: { entries: readonly EntryLike[]; run?: unknown };
		start(listener: (events: readonly Record<string, any>[], context: Context) => Promise<void>): void;
		stop(): Promise<unknown>;
	};
	context: Context;
};

export type DurableDriverEvents = {
	info: (info: AgentSnapshot) => void;
	state: (state: AgentState, toolName?: string) => void;
	status: (status: {
		model: ModelInfo | null;
		thinkingLevel: string;
		thinkingLevels: string[];
		context: ContextInfo | null;
	}) => void;
	"assistant-delta": (id: string, delta: string) => void;
	"assistant-final": (id: string, text: string) => void;
	tool: (toolName: string, phase: "start" | "end", label?: string) => void;
	notify: (level: "info" | "warning" | "error", message: string) => void;
	error: (message: string) => void;
	ready: () => void;
};

/**
 * A stable, monotonic timestamp-cursor for history paging. Entry ids are
 * storage-internal (small sequence numbers in pi-durable 1.1); a plain number
 * is its own cursor, a UUIDv7 encodes its timestamp in the first 48 bits.
 */
function entryTs(id: string): number {
	if (/^\d+$/.test(id)) return Number(id);
	try {
		return Number.parseInt(id.slice(0, 12), 16);
	} catch {
		return 0;
	}
}

export class DurableAgentDriver extends EventEmitter {
	private omni: DurableOmni | null = null;
	private disposed = false;
	private _state: AgentState = "starting";
	private busyRun = false;
	private assistantId: string | null = null;
	private snapshot: AgentSnapshot = { model: null, thinkingLevel: "off", thinkingLevels: [] };
	private context: ContextInfo | null = null;

	readonly cwd: string;
	private readonly create: () => Promise<DurableOmni>;

	constructor(opts: { cwd: string; create: () => Promise<DurableOmni> }) {
		super();
		this.cwd = opts.cwd;
		this.create = opts.create;
	}

	get state(): AgentState {
		return this._state;
	}

	get info(): AgentSnapshot {
		return this.snapshot;
	}

	get status() {
		return {
			model: this.snapshot.model,
			thinkingLevel: this.snapshot.thinkingLevel,
			thinkingLevels: this.snapshot.thinkingLevels,
			context: this.context,
		};
	}

	start(): void {
		if (this.disposed) return;
		void this.boot().catch((err) => this.emit("error", `durable omni failed to start: ${String(err)}`));
	}

	private async boot(): Promise<void> {
		const omni = await this.create();
		if (this.disposed) {
			await omni.harness.close(omni.context);
			return;
		}
		this.omni = omni;
		await omni.events.start(async (events) => this.onEvents(events));
		await this.refreshStatus();
		this.setState(omni.events.snapshot.run ? "thinking" : "idle");
		this.emit("ready");
	}

	/** Translate pi-durable agent events into the AgentPort event vocabulary. */
	private onEvents(events: readonly Record<string, any>[]): void {
		for (const ev of events) {
			switch (ev?.type) {
				case "run_start":
					this.busyRun = true;
					this.setState("thinking");
					break;
				case "run_end":
					this.busyRun = false;
					this.setState("idle");
					void this.refreshStatus();
					break;
				case "message_start":
					this.assistantId = randomUUID();
					break;
				case "message_update": {
					const delta = (ev.changes ?? [])
						.filter((c: any) => c.type === "text_delta")
						.map((c: any) => String(c.delta ?? ""))
						.join("");
					if (delta) {
						if (!this.assistantId) this.assistantId = randomUUID();
						this.setState("streaming");
						this.emit("assistant-delta", this.assistantId, delta);
					}
					break;
				}
				case "message_end": {
					const entry = ev.entry as EntryLike | undefined;
					if (entry?.kind !== "pi.assistant") break;
					const message = entry.model?.[0];
					const text = entry.model ? textFromAssistant(message) : "";
					if (message?.stopReason === "error") {
						this.emit("notify", "error", `agent error: ${message.errorMessage ?? "unknown"}`);
					} else if (message?.stopReason === "stop" && text) {
						// interrupted partials recover as aborted entries — only real
						// finals reach clients (the restart test locks this)
						this.emit("assistant-final", this.assistantId ?? randomUUID(), text);
					}
					this.assistantId = null;
					break;
				}
				case "tool_execution_start":
					this.setState("tool");
					this.emit("tool", ev.toolName, "start", toolLabel(ev.toolName, ev.args));
					break;
				case "tool_execution_end":
					this.emit("tool", ev.toolName, "end");
					this.setState("streaming");
					break;
				case "compaction_start":
					this.setState("compacting");
					break;
				case "compaction_end":
					if (!this.busyRun) this.setState("idle");
					break;
				case "agent_changed":
					void this.refreshStatus();
					this.emit("info", this.info);
					break;
				case "task_failed":
					this.emit("notify", "error", `task failed: ${ev.kind} — ${ev.message}`);
					break;
				case "auto_retry_start":
					this.emit("notify", "warning", `retrying (attempt ${ev.attempt}): ${ev.errorMessage}`);
					break;
				default:
					break;
			}
		}
	}

	private setState(s: AgentState, toolName?: string): void {
		if (this._state === s) return;
		this._state = s;
		this.emit("state", s, toolName);
	}

	private async refreshStatus(): Promise<void> {
		const omni = this.omni;
		if (!omni) return;
		const agent = await omni.conversation.agent(omni.context);
		const raw = agent.model ? omni.models.getModel(agent.model.provider, agent.model.modelId) : undefined;
		const model = toModelInfo(raw ?? null);
		const levels = model?.thinkingLevelMap ? Object.keys(model.thinkingLevelMap) : ["off", "low", "medium", "high"];
		this.snapshot = {
			model,
			thinkingLevel: agent.thinkingLevel ?? "off",
			thinkingLevels: levels,
			sessionId: omni.conversation.id,
			sessionName: "omni (durable)",
		};
		// pi-durable has no exact context-usage API — approximate from the
		// usage ledger (in+out totals) against the model's window.
		try {
			const usage = await omni.harness.usage(omni.context);
			let tokens = 0;
			for (const u of Object.values(usage.models ?? {})) {
				tokens += (u.input ?? 0) + (u.output ?? 0);
			}
			this.context = model
				? {
						tokens,
						contextWindow: model.contextWindow,
						percent: model.contextWindow ? (tokens / model.contextWindow) * 100 : 0,
					}
				: null;
		} catch {
			this.context = null;
		}
		this.emit("status", this.status);
	}

	/** Send a user message; busy turns queue it (followUp) unless `deliver: "steer"`. */
	async prompt(text: string, opts?: { deliver?: "followUp" | "steer" }): Promise<void> {
		const omni = this.omni;
		if (!omni) throw new Error("durable omni not started");
		await omni.conversation.submit(
			{
				type: "input",
				content: text,
				requestId: randomUUID(),
				...(opts?.deliver === "steer" ? { whenBusy: "steer" as const } : {}),
			},
			omni.context,
		);
	}

	async abort(): Promise<void> {
		await this.omni?.conversation.abort(this.omni.context);
	}

	async compact(): Promise<void> {
		const omni = this.omni;
		if (!omni) throw new Error("durable omni not started");
		await omni.conversation.compact(undefined, omni.context);
	}

	/** Reset the conversation's context — the transcript's active window starts over. */
	async newSession(): Promise<void> {
		const omni = this.omni;
		if (!omni) throw new Error("durable omni not started");
		await omni.conversation.reset(undefined, omni.context);
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		const omni = this.omni;
		if (!omni) throw new Error("durable omni not started");
		if (!omni.models.getModel(provider, modelId)) throw new Error(`Model not found: ${provider}/${modelId}`);
		await omni.conversation.configure({ model: { provider, modelId } }, omni.context);
		await this.refreshStatus();
		this.emit("info", this.info);
	}

	async setThinkingLevel(level: string): Promise<void> {
		const omni = this.omni;
		if (!omni) throw new Error("durable omni not started");
		await omni.conversation.configure({ thinkingLevel: level }, omni.context);
		await this.refreshStatus();
	}

	async availableModels(): Promise<ModelInfo[]> {
		const omni = this.omni;
		if (!omni) return [];
		return (await omni.models.getAvailable()).map((m) => toModelInfo(m)).filter((m): m is ModelInfo => m !== null);
	}

	/** The active transcript, newest-last (matches the other drivers' paging shape). */
	async history(opts?: { before?: number; limit?: number }): Promise<{
		entries: Array<{ role: "user" | "assistant"; text: string; ts: number }>;
		hasMore: boolean;
	}> {
		const omni = this.omni;
		if (!omni) return { entries: [], hasMore: false };
		const view = await omni.conversation.viewState(omni.context);
		const all: Array<{ role: "user" | "assistant"; text: string; ts: number }> = [];
		for (const e of view.value.entries) {
			if (e.kind !== "pi.user" && e.kind !== "pi.assistant") continue;
			const message = e.model?.[0];
			if (!message) continue;
			const role = e.kind === "pi.user" ? "user" : "assistant";
			if (role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
				// aborted partials recovered from an interrupted run are
				// bookkeeping, not conversation (the retry answers in full)
				continue;
			}
			const text = role === "user" ? textFromUser(message) : textFromAssistant(message);
			if (!text.trim()) continue;
			all.push({ role, text, ts: entryTs(e.id) });
		}
		const older = opts?.before === undefined ? all : all.filter((e) => e.ts < (opts.before ?? 0));
		const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
		return { entries: older.slice(-limit), hasMore: older.length > limit };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const omni = this.omni;
		if (!omni) return;
		void (async () => {
			try {
				await omni.events.stop();
			} catch {
				// closing the harness ends the stream anyway
			}
			await omni.harness.close(omni.context);
		})();
	}
}
