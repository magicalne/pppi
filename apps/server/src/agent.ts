// Driver for the single omni agent session: spawns `pi --mode rpc` (or a mock
// for tests) and translates the JSONL stdio protocol (see pi docs/rpc.md) into
// typed events for the gateway.
//
// Framing note from pi's docs: strict JSONL — split on "\n" only, strip a
// trailing "\r". Do NOT use readline (it also splits on U+2028/U+2029).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type AgentState = "starting" | "idle" | "thinking" | "tool" | "streaming";

export type AgentSnapshot = {
	model: string | null;
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
	"assistant-delta": (id: string, delta: string) => void;
	"assistant-final": (id: string, text: string) => void;
	tool: (toolName: string, phase: "start" | "end", label?: string) => void;
	notify: (level: "info" | "warning" | "error", message: string) => void;
	error: (message: string) => void;
	ready: () => void;
};

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
			return `running ${(String(a.command ?? "shell") .split(/\s+/)[0] || "shell").slice(0, 24)}`;
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

export class RpcAgentDriver extends EventEmitter {
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
	private snapshot: AgentSnapshot = { model: null };

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

	start(): void {
		if (this.disposed) return;
		this._state = "starting";
		const [cmd, ...args] = this.command;
		if (!cmd) throw new Error("empty agent command");
		const proc = spawn(cmd, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
		this.proc = proc;

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

		this.request("get_state", 15_000)
			.then((res) => {
				if (res.success) {
					const d = res.data ?? {};
					this.snapshot = {
						model: d.model ? `${d.model.provider ?? "?"}/${d.model.id ?? "?"}` : null,
						sessionName: d.sessionName,
						sessionId: d.sessionId,
					};
					this.emit("info", this.snapshot);
					this.setState(d.isStreaming ? "streaming" : "idle");
					this.restartDelay = 1_000;
					this.emit("ready");
				}
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
		this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
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

	async history(): Promise<HistoryEntry[]> {
		const res = await this.request("get_messages", 30_000);
		if (!res.success) throw new Error(res.error ?? "get_messages failed");
		const messages: any[] = res.data?.messages ?? [];
		const out: HistoryEntry[] = [];
		for (const m of messages) {
			if (m.role !== "user" && m.role !== "assistant") continue;
			const text = m.role === "user" ? textFromUser(m) : textFromAssistant(m);
			if (!text.trim()) continue;
			out.push({ role: m.role, text, ts: m.timestamp ?? Date.now() });
		}
		return out.slice(-100);
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
