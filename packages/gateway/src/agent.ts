// Driver for the single omni agent session: spawns `pi --mode rpc` (or a mock
// for tests) and translates the JSONL stdio protocol (see pi docs/rpc.md) into
// typed events for the gateway.
//
// Framing note from pi's docs: strict JSONL — split on "\n" only, strip a
// trailing "\r". Do NOT use readline (it also splits on U+2028/U+2029).

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentStatus, ContextInfo, ModelInfo } from "@pppi/protocol";

export type AgentState = "starting" | "idle" | "thinking" | "tool" | "streaming" | "compacting";

export type AgentSnapshot = {
	model: ModelInfo | null;
	/** pi canonical level of the current model: "off"…"max" */
	thinkingLevel: string;
	/** levels the current model supports (canonical order); empty until first refresh */
	thinkingLevels: string[];
	sessionName?: string;
	sessionId?: string;
};

export type HistoryEntry = { role: "user" | "assistant"; text: string; ts: number };

type RpcResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: any;
	error?: string;
};

type RpcEvent = { type: string } & Record<string, any>;

export type DriverEvents = {
	info: (info: AgentSnapshot) => void;
	state: (state: AgentState) => void;
	status: (status: AgentStatus) => void;
	"assistant-delta": (id: string, delta: string) => void;
	"assistant-final": (id: string, text: string) => void;
	tool: (toolName: string, phase: "start" | "end", label?: string) => void;
	notify: (level: "info" | "warning" | "error", message: string) => void;
	error: (message: string) => void;
	ready: () => void;
};

/**
 * What a gateway needs from "an agent". Implemented by RpcAgentDriver (the
 * `pi --mode rpc` child used by the cli host and `/omni child`) and later by
 * the in-process extension driver (`/omni` hosting its own session). The
 * events are exactly the DriverEvents above — the gateway maps them to wire.
 */
export interface AgentPort extends EventEmitter {
	/** Working directory the agent runs in (pi settings resolution). */
	readonly cwd: string;
	get state(): AgentState;
	get info(): AgentSnapshot;
	/** Last known status-bar snapshot; safest read is the `status` event. */
	get status(): AgentStatus;
	/** Send a user message; queues behind an active turn (followUp semantics). */
	prompt(text: string): Promise<void>;
	abort(): void | Promise<void>;
	/** Compact the session now (LLM summarization; seconds to minutes). */
	compact(): Promise<void>;
	/** Reset to a fresh session; history is empty afterwards. */
	newSession(): Promise<void>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	/** Models pi can run (auth-configured providers); the enabled filter lives in the gateway. */
	availableModels(): Promise<ModelInfo[]>;
	history(opts?: { before?: number; limit?: number }): Promise<{ entries: HistoryEntry[]; hasMore: boolean }>;
}

/** Map pi's Model (pi-ai) to the wire ModelInfo; tolerant of partial data (mock/tests). */
function toModelInfo(m: any): ModelInfo | null {
	if (!m || typeof m !== "object" || !m.provider || !m.id) return null;
	return {
		provider: String(m.provider),
		id: String(m.id),
		name: String(m.name ?? `${m.provider}/${m.id}`),
		reasoning: m.reasoning === true,
		contextWindow: Number(m.contextWindow ?? 0) || 0,
		thinkingLevelMap: m.thinkingLevelMap && typeof m.thinkingLevelMap === "object" ? { ...m.thinkingLevelMap } : {},
	};
}

function toContextInfo(cu: any): ContextInfo | null {
	if (!cu || typeof cu !== "object") return null;
	return {
		tokens: typeof cu.tokens === "number" ? cu.tokens : null,
		contextWindow: Number(cu.contextWindow ?? 0) || 0,
		percent: typeof cu.percent === "number" ? cu.percent : null,
	};
}

/** One-line "verb + object" status copy for a tool call (PRD §5). */
export function toolLabel(toolName: string, args: any): string {
	const a = args ?? {};
	const p = (v: any) => {
		const s = String(v ?? "");
		if (!s) return "";
		const parts = s.split("/").filter(Boolean);
		return parts.slice(-2).join("/") || s;
	};
	switch (toolName) {
		case "read":
			return `reading ${p(a.path ?? a.file_path ?? a.abs_path)}`;
		case "write":
		case "edit":
			return `writing ${p(a.path ?? a.file_path)}`;
		case "bash":
			return `running ${(String(a.command ?? "shell").split(/\s+/)[0] || "shell").slice(0, 24)}`;
		case "glob":
		case "grep":
			return `searching ${String(a.pattern ?? "").slice(0, 24)}`;
		case "pigeon":
			return a.action === "send" ? `asking ${a.target ?? "a session"}` : "coordinating";
		default:
			if (toolName.startsWith("omni_")) return "coordinating";
			return `running ${toolName}`;
	}
}

export class RpcAgentDriver extends EventEmitter implements AgentPort {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<string, { resolve: (r: RpcResponse) => void; timer: NodeJS.Timeout }>();
	private disposed = false;
	private isStreaming = false;
	private assistantId: string | null = null;
	private assistantText = "";
	private restartDelay = 1_000;
	private _state: AgentState = "starting";
	private snapshot: AgentSnapshot = { model: null, thinkingLevel: "off", thinkingLevels: [] };
	private context: ContextInfo | null = null;
	private modelsCache: { at: number; models: ModelInfo[] } | null = null;

	readonly command: string[];
	readonly cwd: string;

	constructor(opts: { command: string[]; cwd: string }) {
		super();
		this.command = opts.command;
		this.cwd = opts.cwd;
	}

	get state(): AgentState {
		return this._state;
	}

	get info(): AgentSnapshot {
		return this.snapshot;
	}

	/** Last known status-bar snapshot; safest read is the `status` event. */
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
		this._state = "starting";
		const [cmd, ...args] = this.command;
		if (!cmd) throw new Error("empty agent command");
		const proc = spawn(cmd, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
		this.proc = proc;

		// spawn failures (bad cwd, missing binary) surface here, not via exit
		proc.on("error", (err) => {
			this.emit("error", `failed to spawn omni agent: ${err.message}`);
			this.setState("starting");
		});
		// teardown races can EPIPE the stdin stream itself — swallow, dispose() handles the rest
		proc.stdin?.on("error", () => {});

		proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		proc.stderr.on("data", (chunk: Buffer) => {
			const line = chunk.toString().trim();
			if (line) this.emit("error", `agent stderr: ${line.slice(0, 500)}`);
		});
		proc.on("exit", (code) => {
			this.proc = null;
			this.isStreaming = false;
			if (this.disposed) return;
			this.emit("error", `omni agent exited (code ${code}); restarting`);
			this.setState("starting");
			setTimeout(() => {
				this.restartDelay = Math.min(this.restartDelay * 2, 10_000);
				this.start();
			}, this.restartDelay);
		});

		this.request("get_state", 30_000)
			.then(async (res) => {
				if (!res.success) return;
				const d = res.data ?? {};
				this.snapshot = {
					model: toModelInfo(d.model),
					thinkingLevel: typeof d.thinkingLevel === "string" ? d.thinkingLevel : "off",
					thinkingLevels: [],
					sessionName: d.sessionName,
					sessionId: d.sessionId,
				};
				await this.refreshLevels().catch(() => {});
				await this.refreshStats().catch(() => {});
				this.emit("info", this.snapshot);
				this.emitStatus();
				this.setState(d.isStreaming ? "streaming" : "idle");
				// auto-compaction is pi's default, but a local setting could have
				// it off — the context bar staying honest depends on it
				void this.request("set_auto_compaction", 10_000, { enabled: true }).catch(() => {});
				this.restartDelay = 1_000;
				this.emit("ready");
			})
			.catch((err) => this.emit("error", `get_state failed: ${err.message}`));
	}

	private setState(s: AgentState, toolName?: string): void {
		if (this._state === s) return;
		this._state = s;
		this.emit("state", s, toolName);
	}

	private write(obj: Record<string, unknown>): void {
		if (!this.proc?.stdin.writable) return;
		// the child can vanish between the writable check and the write (EPIPE)
		this.proc.stdin.write(`${JSON.stringify(obj)}\n`, (err) => {
			void err;
		});
	}

	private request(type: string, timeoutMs = 30_000, extra: Record<string, unknown> = {}): Promise<RpcResponse> {
		const id = `rpc-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${type} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, timer });
			this.write({ id, type, ...extra });
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		for (;;) {
			const nl = this.buffer.indexOf("\n");
			if (nl === -1) break;
			let line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.type === "response") this.onResponse(msg as RpcResponse);
			else this.onEvent(msg as RpcEvent);
		}
	}

	private onResponse(res: RpcResponse): void {
		if (res.id && this.pending.has(res.id)) {
			const p = this.pending.get(res.id)!;
			clearTimeout(p.timer);
			this.pending.delete(res.id);
			p.resolve(res);
		}
	}

	private onEvent(ev: RpcEvent): void {
		switch (ev.type) {
			case "extension_ui_request": {
				// Headless: never block the agent on dialogs; auto-dismiss.
				const dialog = ["select", "confirm", "input", "editor"].includes(ev.method);
				if (dialog) this.write({ type: "extension_ui_response", id: ev.id, cancelled: true });
				// Only real notifications reach clients; setStatus/setWidget/setTitle are TUI noise.
				if (ev.method === "notify") this.emit("notify", ev.notifyType ?? "info", ev.message ?? "");
				break;
			}
			case "agent_start":
				this.isStreaming = true;
				this.assistantId = null;
				this.assistantText = "";
				this.setState("thinking");
				break;
			case "agent_settled":
				this.isStreaming = false;
				this.setState("idle");
				// context usage changed (the assistant just answered) — refresh the bar
				void this.refreshStats()
					.then(() => this.emitStatus())
					.catch(() => {});
				break;
			case "compaction_start":
				// pi auto-compacts at the context threshold by default; /compact lands here too
				this.setState("compacting");
				break;
			case "compaction_end":
				this.setState("idle");
				// context usage just collapsed — refresh the bar
				void this.refreshStats()
					.then(() => this.emitStatus())
					.catch(() => {});
				break;
			case "tool_execution_start":
				this.setState("tool", ev.toolName);
				this.emit("tool", ev.toolName, "start", toolLabel(ev.toolName, ev.args));
				break;
			case "tool_execution_end":
				this.emit("tool", ev.toolName, "end");
				this.setState("streaming");
				break;
			case "message_update": {
				const delta = ev.assistantMessageEvent;
				if (!delta) break;
				if (delta.type === "text_delta") {
					if (!this.assistantId) this.assistantId = randomUUID();
					this.setState("streaming");
					this.assistantText += delta.delta ?? "";
					this.emit("assistant-delta", this.assistantId, delta.delta ?? "");
				}
				break;
			}
			case "message_end": {
				const msg = ev.message;
				if (msg?.role === "assistant") {
					if (msg.stopReason === "error") {
						this.emit("notify", "error", `agent error: ${msg.errorMessage ?? "unknown"}`);
					}
					const text = textFromAssistant(msg);
					if (text) {
						const id = this.assistantId ?? randomUUID();
						this.emit("assistant-final", id, text);
					}
					this.assistantId = null;
					this.assistantText = "";
				}
				break;
			}
			default:
				break;
		}
	}

	/** Send a user message; queues behind an active turn (followUp semantics). */
	async prompt(text: string): Promise<void> {
		const extra: Record<string, unknown> = this.isStreaming ? { streamingBehavior: "followUp" } : {};
		const res = await this.request("prompt", 30_000, { message: text, ...extra });
		if (!res.success) {
			// Race: streaming started between our check and the command.
			if (!this.isStreaming || /stream/i.test(res.error ?? "")) {
				const retry = await this.request("prompt", 30_000, { message: text, streamingBehavior: "followUp" });
				if (!retry.success) throw new Error(retry.error ?? "prompt rejected");
				return;
			}
			throw new Error(res.error ?? "prompt rejected");
		}
	}

	async abort(): Promise<void> {
		this.write({ type: "abort" });
	}

	/** Compact the session (LLM summarization — can take a while). */
	async compact(): Promise<void> {
		const res = await this.request("compact", 300_000, {});
		if (!res.success) throw new Error(res.error ?? "compact failed");
	}

	/** Reset to a fresh session; the old conversation stays on disk. */
	async newSession(): Promise<void> {
		const res = await this.request("new_session", 30_000, {});
		if (!res.success) throw new Error(res.error ?? "new session failed");
		await this.refreshStats().catch(() => {});
		this.emitStatus();
	}

	// ------------------------------------------------------------- status bar

	private emitStatus(): void {
		this.emit("status", this.status);
	}

	private applyState(d: any): void {
		this.snapshot = {
			model: toModelInfo(d.model),
			thinkingLevel: typeof d.thinkingLevel === "string" ? d.thinkingLevel : "off",
			thinkingLevels: this.snapshot.thinkingLevels,
			sessionName: d.sessionName,
			sessionId: d.sessionId,
		};
	}

	private async refreshState(): Promise<void> {
		const res = await this.request("get_state", 15_000);
		if (res.success) this.applyState(res.data ?? {});
	}

	private async refreshLevels(): Promise<void> {
		const res = await this.request("get_available_thinking_levels", 15_000);
		if (res.success && Array.isArray(res.data?.levels)) {
			this.snapshot.thinkingLevels = res.data.levels.filter((l: unknown): l is string => typeof l === "string");
		}
	}

	private async refreshStats(): Promise<void> {
		const res = await this.request("get_session_stats", 15_000);
		if (res.success) this.context = toContextInfo(res.data?.contextUsage);
	}

	/** Re-read everything the status bar shows; individual misses keep prior values. */
	private async refreshStatus(): Promise<void> {
		await Promise.all([
			this.refreshState().catch(() => {}),
			this.refreshLevels().catch(() => {}),
			this.refreshStats().catch(() => {}),
		]);
	}

	/** Switch the omni session's model (pi validates against available models). */
	async setModel(provider: string, modelId: string): Promise<void> {
		const res = await this.request("set_model", 30_000, { provider, modelId });
		if (!res.success) throw new Error(res.error ?? "set_model failed");
		await this.refreshStatus();
		this.emit("info", this.snapshot);
		this.emitStatus();
	}

	/** Set thinking effort (pi clamps to what the model supports; we mirror the clamped value). */
	async setThinkingLevel(level: string): Promise<void> {
		const res = await this.request("set_thinking_level", 15_000, { level });
		if (!res.success) throw new Error(res.error ?? "set_thinking_level failed");
		await this.refreshState().catch(() => {});
		this.emitStatus();
	}

	/** Models pi can run (auth-configured providers), cached — the enabled filter lives in server.ts. */
	async availableModels(): Promise<ModelInfo[]> {
		if (this.modelsCache && Date.now() - this.modelsCache.at < 5 * 60_000) return this.modelsCache.models;
		const res = await this.request("get_available_models", 30_000);
		if (!res.success) throw new Error(res.error ?? "get_available_models failed");
		const models = (Array.isArray(res.data?.models) ? res.data.models : [])
			.map(toModelInfo)
			.filter((m: ModelInfo | null): m is ModelInfo => m !== null);
		this.modelsCache = { at: Date.now(), models };
		return models;
	}

	/**
	 * A page of conversation history, newest-last. Without `before`: the most
	 * recent `limit` entries. With `before` (ms epoch): the most recent `limit`
	 * entries strictly older than it, plus whether even older ones exist.
	 */
	async history(opts?: { before?: number; limit?: number }): Promise<{ entries: HistoryEntry[]; hasMore: boolean }> {
		const res = await this.request("get_messages", 30_000);
		if (!res.success) throw new Error(res.error ?? "get_messages failed");
		const messages: any[] = res.data?.messages ?? [];
		const all: HistoryEntry[] = [];
		for (const m of messages) {
			if (m.role !== "user" && m.role !== "assistant") continue;
			const text = m.role === "user" ? textFromUser(m) : textFromAssistant(m);
			if (!text.trim()) continue;
			all.push({ role: m.role, text, ts: m.timestamp ?? Date.now() });
		}
		const older = opts?.before === undefined ? all : all.filter((e) => e.ts < (opts.before ?? 0));
		const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
		return { entries: older.slice(-limit), hasMore: older.length > limit };
	}

	dispose(): void {
		this.disposed = true;
		this.proc?.kill("SIGTERM");
		for (const [, p] of this.pending) clearTimeout(p.timer);
		this.pending.clear();
	}
}

function textFromUser(m: any): string {
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text ?? "")
			.join("");
	}
	return "";
}

function textFromAssistant(m: any): string {
	if (Array.isArray(m.content)) {
		return m.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text ?? "")
			.join("");
	}
	if (typeof m.content === "string") return m.content;
	return "";
}
