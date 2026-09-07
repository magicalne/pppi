import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcAgentDriver } from "../src/agent.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "mock-agent.mjs");

describe("rpc agent driver", () => {
	let driver: RpcAgentDriver;

	beforeEach(() => {
		process.env.MOCK_REPLY = "all green: 264 passed";
		driver = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
	});

	afterEach(async () => {
		driver.dispose();
	});

	it("reports agent info once started", async () => {
		const info = await new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no info")), 10_000);
			driver.on("info", (i) => {
				clearTimeout(timer);
				resolve(i);
			});
			driver.start();
		});
		expect(info.model).toMatchObject({ provider: "mock", id: "mock-1" });
		expect(info.sessionName).toBe("omni");
	});

	it("broadcasts a status snapshot with model, levels and context", async () => {
		const status = await new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no status")), 10_000);
			driver.on("status", (s) => {
				clearTimeout(timer);
				resolve(s);
			});
			driver.start();
		});
		expect(status.model).toMatchObject({ provider: "mock", id: "mock-1", reasoning: true, contextWindow: 100_000 });
		expect(status.thinkingLevel).toBe("low");
		expect(status.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
		expect(status.context).toMatchObject({ contextWindow: 100_000 });
		expect(status.context.tokens).toBeGreaterThan(0);
	});

	it("set_thinking_level echoes the clamped level", async () => {
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		await driver.setThinkingLevel("max"); // mock supports up to high
		expect(driver.status.thinkingLevel).toBe("high");
	});

	it("set_model switches model and its supported levels", async () => {
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		await driver.setModel("other", "other-1");
		expect(driver.status.model).toMatchObject({ provider: "other", id: "other-1" });
		// other-1's map omits minimal → pi's default marks it supported
		expect(driver.status.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		await expect(driver.setModel("mock", "nope")).rejects.toThrow(/Model not found/);
	});

	it("refreshes context usage after each settled turn", async () => {
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		const before = driver.status.context?.tokens ?? 0;
		const settled = new Promise<void>((r) => driver.on("status", () => r()));
		await driver.prompt("hello");
		await new Promise<void>((r) => driver.once("assistant-final", r));
		await settled;
		expect(driver.status.context?.tokens ?? 0).toBeGreaterThan(before);
	});

	it("pages history: recent window, then strictly-older pages with hasMore", async () => {
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		for (const q of ["one", "two", "three"]) {
			// attach before prompting: the mock streams the whole turn in one chunk
			const done = new Promise<void>((r) => driver.once("assistant-final", r));
			await driver.prompt(q);
			await done;
		}
		// 3 exchanges = 6 entries; take the recent 2
		const recent = await driver.history({ limit: 2 });
		expect(recent.entries.map((h) => h.text)).toEqual(["three", "all green: 264 passed"]);
		expect(recent.hasMore).toBe(true);

		// older than the recent page: exactly the remaining 4, no more (newest-last)
		const older = await driver.history({ before: recent.entries[0]!.ts, limit: 10 });
		expect(older.entries.map((h) => h.text)).toEqual(["one", "all green: 264 passed", "two", "all green: 264 passed"]);
		expect(older.hasMore).toBe(false);

		// a page bounded in the middle leaves more behind it
		const mid = await driver.history({ before: recent.entries[0]!.ts, limit: 2 });
		expect(mid.entries).toHaveLength(2);
		expect(mid.hasMore).toBe(true);
	});

	it("streams deltas and a final assistant message", async () => {
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));

		const deltas: string[] = [];
		const finals: string[] = [];
		driver.on("assistant-delta", (_id, d) => deltas.push(d));
		driver.on("assistant-final", (_id, t) => finals.push(t));

		await driver.prompt("run the tests");
		await new Promise<void>((r) => {
			const check = setInterval(() => {
				if (finals.length > 0) {
					clearInterval(check);
					r();
				}
			}, 50);
			setTimeout(() => {
				clearInterval(check);
				r();
			}, 5_000);
		});

		expect(deltas.join("")).toBe("all green: 264 passed");
		expect(finals[0]).toBe("all green: 264 passed");
		expect(driver.state).toBe("idle");
	});

	it("returns conversation history", async () => {
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		const done = new Promise<void>((r) => driver.once("assistant-final", r));
		await driver.prompt("hello");
		await done;
		const { entries } = await driver.history();
		expect(entries.map((h) => h.role)).toEqual(["user", "assistant"]);
		expect(entries[1]!.text).toBe("all green: 264 passed");
	});

	it("transitions through thinking/streaming states", async () => {
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		const states: string[] = [];
		driver.on("state", (s) => states.push(s));
		await driver.prompt("hi");
		await new Promise<void>((r) => driver.once("assistant-final", r));
		await new Promise<void>((r, j) => {
			if (driver.state === "idle") return r();
			const timer = setTimeout(() => j(new Error("never settled to idle")), 5_000);
			driver.on("state", (s) => {
				if (s === "idle") {
					clearTimeout(timer);
					r();
				}
			});
		});
		expect(states).toContain("thinking");
		expect(states).toContain("streaming");
		expect(states.at(-1)).toBe("idle");
	});
});
