import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RpcAgentDriver } from "../src/agent.ts";
import { SdkAgentDriver, type SdkSessionLike } from "../src/sdk-driver.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "mock-agent.mjs");

const MOCK_MODEL = {
	provider: "mock",
	id: "mock-1",
	name: "Mock 1",
	reasoning: true,
	contextWindow: 100_000,
	thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" },
};

/** A SdkSessionLike that plays scripted events and records what the driver calls. */
class FakeSdkSession implements SdkSessionLike {
	listeners: Array<(event: any) => void> = [];
	calls: Array<{ fn: string; args: unknown[] }> = [];
	disposed = 0;
	streaming = false;
	compacting = false;
	model = MOCK_MODEL;
	thinkingLevel = "low";
	sessionId = "sdk-session-0000";
	sessionName = "omni";
	messages: Array<Record<string, any>> = [];

	subscribe(listener: (event: any) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const i = this.listeners.indexOf(listener);
			if (i >= 0) this.listeners.splice(i, 1);
		};
	}

	emit(event: any): void {
		for (const l of [...this.listeners]) l(event);
	}

	dispose(): void {
		this.disposed++;
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	get isCompacting(): boolean {
		return this.compacting;
	}

	getAvailableThinkingLevels(): string[] {
		return ["off", "low", "medium", "high"];
	}

	getContextUsage(): any {
		return { tokens: 4_200, contextWindow: 100_000, percent: 4.2 };
	}

	get modelRuntime(): any {
		return {
			getModel: (provider: string, id: string) => (provider === "mock" && id === "mock-1" ? MOCK_MODEL : undefined),
			getAvailable: async () => [MOCK_MODEL],
		};
	}

	async prompt(text: string, options?: any): Promise<void> {
		this.calls.push({ fn: "prompt", args: [text, options] });
		// the real session reports what became of the input via preflightResult
		if (text.startsWith("/")) options?.preflightResult?.("handled");
		else options?.preflightResult?.("started");
	}

	async steer(text: string): Promise<"handled" | "queued"> {
		this.calls.push({ fn: "steer", args: [text] });
		return "queued";
	}

	async followUp(text: string): Promise<"handled" | "queued"> {
		this.calls.push({ fn: "followUp", args: [text] });
		return "queued";
	}

	async abort(): Promise<void> {
		this.calls.push({ fn: "abort", args: [] });
	}

	async compact(): Promise<unknown> {
		this.calls.push({ fn: "compact", args: [] });
		return {};
	}

	async setModel(model: unknown): Promise<void> {
		this.calls.push({ fn: "setModel", args: [model] });
	}

	setThinkingLevel(level: string): void {
		this.calls.push({ fn: "setThinkingLevel", args: [level] });
	}
}

/** One scripted turn, event-for-event what pi emits (agent-session.ts). */
function playTurn(session: FakeSdkSession, text: string): void {
	session.streaming = true;
	session.emit({ type: "agent_start" });
	session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	for (const part of text.match(/[\s\S]{1,7}/g) ?? []) {
		session.emit({
			type: "message_update",
			message: {},
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: part },
		});
	}
	const assistant = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
	session.emit({ type: "message_end", message: assistant });
	session.emit({ type: "agent_end", messages: [assistant], willRetry: false });
	session.streaming = false;
	session.emit({ type: "agent_settled" });
}

type Logged = [string, ...unknown[]];

/** Message ids are randomUUID per driver — compare shapes, not identities. */
function normalizeIds(log: Logged[]): Logged[] {
	return log.map(([evt, ...args]) => [
		evt,
		...args.map((a) => (typeof a === "string" && /^[0-9a-f-]{36}$/.test(a) ? "<id>" : a)),
	]) as Logged[];
}

function logEvents(driver: SdkAgentDriver | RpcAgentDriver): Logged[] {
	const log: Logged[] = [];
	for (const evt of ["state", "assistant-delta", "assistant-final", "tool", "notify", "error"] as const) {
		driver.on(evt, ((...args: unknown[]) => log.push([evt, ...args])) as never);
	}
	return log;
}

describe("sdk agent driver", () => {
	it("mirrors the rpc driver's observable events for the same scripted turn", async () => {
		// rpc side: the mock child speaks the same event sequence over JSONL
		process.env.MOCK_REPLY = "all green: 264 passed";
		const rpc = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
		const rpcLog = logEvents(rpc);
		rpc.start();
		await new Promise<void>((r) => rpc.once("ready", r));
		const rpcDone = new Promise<void>((r) => rpc.once("assistant-final", r));
		await rpc.prompt("hello");
		await rpcDone;
		// the mock emits synchronously — idle may already have fired
		if (rpc.state !== "idle") {
			await new Promise<void>((r) =>
				rpc.once("state", (s) => {
					if (s === "idle") r();
				}),
			);
		}
		rpc.dispose();

		// sdk side: the stub session plays pi's identical event sequence
		const session = new FakeSdkSession();
		const driver = new SdkAgentDriver({ cwd: "/tmp", create: async () => ({ session }) });
		const sdkLog = logEvents(driver);
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		const p = driver.prompt("hello");
		playTurn(session, "all green: 264 passed");
		await p;

		expect(normalizeIds(sdkLog)).toEqual(normalizeIds(rpcLog));
		driver.dispose();
	});

	it("reports info and status snapshots from the session", async () => {
		const session = new FakeSdkSession();
		const driver = new SdkAgentDriver({ cwd: "/tmp", create: async () => ({ session }) });
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		expect(driver.info).toMatchObject({
			model: { provider: "mock", id: "mock-1" },
			thinkingLevel: "low",
			thinkingLevels: ["off", "low", "medium", "high"],
			sessionName: "omni",
		});
		expect(driver.status.context).toMatchObject({ tokens: 4_200, contextWindow: 100_000 });
		const models = await driver.availableModels();
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ provider: "mock", id: "mock-1" });
		driver.dispose();
	});

	it("queues behind a busy turn and reports a handled disposition", async () => {
		const session = new FakeSdkSession();
		const driver = new SdkAgentDriver({ cwd: "/tmp", create: async () => ({ session }) });
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		session.streaming = true;

		await driver.prompt("queued behind the run");
		expect(session.calls.at(-1)?.fn).toBe("prompt");
		expect((session.calls.at(-1)?.args[1] as any)?.streamingBehavior).toBe("followUp");

		// extension commands ride the same path; pi marks them handled
		const notified = new Promise<string>((r) => driver.once("notify", (_l, m) => r(m)));
		await driver.prompt("/pppi_profile");
		expect(session.calls.at(-1)?.fn).toBe("prompt");
		expect(await notified).toMatch(/handled/);
		driver.dispose();
	});

	it("prompt(steer) injects into the running turn", async () => {
		const session = new FakeSdkSession();
		const driver = new SdkAgentDriver({ cwd: "/tmp", create: async () => ({ session }) });
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		session.streaming = true;
		await driver.prompt("the rest of my thought", { deliver: "steer" });
		expect(session.calls.at(-1)?.fn).toBe("prompt");
		expect((session.calls.at(-1)?.args[1] as any)?.streamingBehavior).toBe("steer");
		expect(session.calls.at(-1)?.args[0]).toBe("the rest of my thought");
		driver.dispose();
	});

	it("pages history newest-last with hasMore, like the rpc driver", async () => {
		const session = new FakeSdkSession();
		session.messages = [
			{ role: "user", content: "one", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "answer one" }], timestamp: 2 },
			{ role: "user", content: "two", timestamp: 3 },
			{ role: "assistant", content: [{ type: "text", text: "answer two" }], timestamp: 4 },
		];
		const driver = new SdkAgentDriver({ cwd: "/tmp", create: async () => ({ session }) });
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		const recent = await driver.history({ limit: 2 });
		expect(recent.entries.map((h) => h.text)).toEqual(["two", "answer two"]);
		expect(recent.hasMore).toBe(true);
		const older = await driver.history({ before: recent.entries[0]!.ts, limit: 10 });
		expect(older.entries.map((h) => h.text)).toEqual(["one", "answer one"]);
		expect(older.hasMore).toBe(false);
		driver.dispose();
	});

	it("newSession replaces the underlying session", async () => {
		const first = new FakeSdkSession();
		const second = new FakeSdkSession();
		const sessions = [first, second];
		const driver = new SdkAgentDriver({
			cwd: "/tmp",
			create: async () => ({ session: sessions.shift()! }),
		});
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		await driver.newSession();
		expect(first.disposed).toBe(1);
		expect(first.listeners).toHaveLength(0); // detached
		expect(driver.state).toBe("idle");
		driver.dispose();
		expect(second.disposed).toBe(1);
	});
});
