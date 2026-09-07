// In-process agent driver for `/omni here`: instead of spawning a `pi --mode
// rpc` child, this drives the HOST session through pi's extension API and
// emits the same events the gateway's wire mapping expects. The RPC event
// vocabulary in @pppi/gateway's driver is pi's own extension event bus, so
// this is a re-plumbing, not a re-implementation.
//
// Structurally satisfies the gateway's AgentPort (EventEmitter + the same
// members); the gateway only needs that shape.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { toolLabel } from "@pppi/gateway";
import type { ModelInfo } from "@pppi/protocol";

type AnyModel = {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	thinkingLevelMap?: Record<string, string | null | undefined>;
};

type Ctx = {
	abort(): void;
	isIdle?(): boolean;
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	model?: AnyModel | undefined;
	thinkingLevel?: string;
	sessionManager: {
		getEntries(): Array<Record<string, any>>;
		getSessionId?(): string;
		getSessionName?(): string | undefined;
	};
	modelRegistry: { getAvailable(): AnyModel[] };
};

/** pi-ai Model → wire ModelInfo (drop non-string thinkingLevelMap entries). */
function toModelInfo(m: AnyModel | undefined | null): ModelInfo | null {
	if (!m || !m.provider || !m.id) return null;
	const thinkingLevelMap: Record<string, string> = {};
	for (const [k, v] of Object.entries(m.thinkingLevelMap ?? {})) {
		if (typeof v === "string") thinkingLevelMap[k] = v;
	}
	return {
		provider: String(m.provider),
		id: String(m.id),
		name: String(m.name ?? `${m.provider}/${m.id}`),
		reasoning: m.reasoning === true,
		contextWindow: Number(m.contextWindow ?? 0) || 0,
		thinkingLevelMap,
	};
}

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// mirrors pi-ai getSupportedThinkingLevels
function supportedLevels(model: AnyModel | null): string[] {
	if (!model?.reasoning) return ["off"];
	const map = model.thinkingLevelMap ?? {};
	return LEVEL_ORDER.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if ((level === "xhigh" || level === "max") && mapped === undefined) return false;
		return true;
	});
}

function textOf(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text ?? "")
			.join("");
	}
	return "";
}

export class ExtensionAgentDriver extends EventEmitter {
	private ctx: Ctx | undefined;
	private isStreaming = false;
	private assistantId: string | null = null;
	private _state = "starting";
	private snapshot: {
		model: ModelInfo | null;
		thinkingLevel: string;
		thinkingLevels: string[];
		sessionId?: string;
		sessionName?: string;
	} = { model: null, thinkingLevel: "off", thinkingLevels: [] };
	private context: { tokens: number | null; contextWindow: number; percent: number | null } | null = null;

	readonly cwd: string;

	constructor(
		private pi: any,
		cwd: string,
	) {
		super();
		this.cwd = cwd;
	}

	/** Give the driver the invoking command's context (needed before any event fires). */
	setCtx(ctx: Ctx): void {
		this.ctx = ctx;
	}

	/** Subscribe to the session's event bus; call once before first use. */
	attach(): void {
		this.pi.on("agent_start", async () => {
			this.isStreaming = true;
			this.assistantId = null;
			this.setState("thinking");
		});
		this.pi.on("agent_settled", async (_event: unknown, ctx: Ctx) => {
			this.isStreaming = false;
			this.setState("idle");
			this.ctx = ctx;
			this.refreshStatus();
		});
		// error turns end without a settle — agent_end is the reliable "not busy"
		this.pi.on("agent_end", async (_event: unknown, ctx: Ctx) => {
			this.isStreaming = false;
			this.ctx = ctx;
		});
		this.pi.on("tool_execution_start", async (event: any, ctx: Ctx) => {
			this.ctx = ctx;
			this.setState("tool");
			this.emit("tool", event.toolName, "start", toolLabel(event.toolName, event.args));
		});
		this.pi.on("tool_execution_end", async (event: any) => {
			this.emit("tool", event.toolName, "end");
			this.setState("streaming");
		});
		this.pi.on("message_update", async (event: any) => {
			const delta = event.assistantMessageEvent;
			if (delta?.type !== "text_delta") return;
			if (!this.assistantId) this.assistantId = randomUUID();
			this.setState("streaming");
			this.emit("assistant-delta", this.assistantId, delta.delta ?? "");
		});
		this.pi.on("message_end", async (event: any) => {
			const message = event.message;
			if (message?.role !== "assistant") return;
			if (message.stopReason === "error") {
				this.emit("notify", "error", `agent error: ${message.errorMessage ?? "unknown"}`);
			}
			const text = textOf(message);
			if (text) this.emit("assistant-final", this.assistantId ?? randomUUID(), text);
			this.assistantId = null;
		});
		this.pi.on("model_select", async (_event: unknown, ctx: Ctx) => {
			this.ctx = ctx;
			this.refreshStatus();
			this.emit("info", this.info);
		});
		this.pi.on("session_compact", async () => this.refreshStatus());
	}

	private setState(s: string): void {
		if (this._state === s) return;
		this._state = s;
		this.emit("state", s);
	}

	/** Re-read everything the status bar shows; call when the session settled. */
	refreshStatus(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const model = toModelInfo(ctx.model);
		this.snapshot = {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionName: ctx.sessionManager.getSessionName?.() ?? undefined,
			model,
			thinkingLevel: this.pi.getThinkingLevel() ?? "off",
			thinkingLevels: supportedLevels(ctx.model ?? null),
		};
		this.context = ctx.getContextUsage() ?? null;
		if (this._state === "starting") this._state = "idle";
		this.emit("status", this.status);
	}

	get state(): string {
		return this._state;
	}

	get info() {
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

	async prompt(text: string): Promise<void> {
		// busy turns get followUp delivery — pi queues the message instead of
		// racing. Ask PI (ctx.isIdle) rather than trusting our own flag: an
		// error turn can settle without our handlers seeing a clean transition.
		const busy = this.ctx?.isIdle ? !this.ctx.isIdle() : this.isStreaming;
		await this.pi.sendUserMessage(text, busy ? { deliverAs: "followUp" } : undefined);
	}

	abort(): void {
		this.ctx?.abort();
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) throw new Error("not attached to a session yet");
		const found = ctx.modelRegistry.getAvailable().find((m) => m.provider === provider && m.id === modelId);
		if (!found) throw new Error(`Model not found: ${provider}/${modelId}`);
		const ok = await this.pi.setModel(found);
		if (!ok) throw new Error(`no API key available for ${provider}/${modelId}`);
		this.refreshStatus();
		this.emit("info", this.info);
	}

	async setThinkingLevel(level: string): Promise<void> {
		this.pi.setThinkingLevel(level);
		this.refreshStatus();
	}

	async availableModels(): Promise<ModelInfo[]> {
		const ctx = this.ctx;
		if (!ctx) return [];
		return ctx.modelRegistry
			.getAvailable()
			.map(toModelInfo)
			.filter((m): m is ModelInfo => m !== null);
	}

	async history(opts?: { before?: number; limit?: number }): Promise<{
		entries: Array<{ role: "user" | "assistant"; text: string; ts: number }>;
		hasMore: boolean;
	}> {
		const ctx = this.ctx;
		if (!ctx) return { entries: [], hasMore: false };
		const all: Array<{ role: "user" | "assistant"; text: string; ts: number }> = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message?.role !== "user" && message?.role !== "assistant") continue;
			const text = textOf(message);
			if (!text.trim()) continue;
			const ts = Date.parse(entry.timestamp);
			all.push({ role: message.role, text, ts: Number.isNaN(ts) ? Date.now() : ts });
		}
		const older = opts?.before === undefined ? all : all.filter((e) => e.ts < (opts.before ?? 0));
		const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
		return { entries: older.slice(-limit), hasMore: older.length > limit };
	}
}
