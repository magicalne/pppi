import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcAgentDriver } from "../src/agent.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mock-agent.mjs");

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
		expect(info.model).toBe("mock/mock-1");
		expect(info.sessionName).toBe("omni");
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
		await driver.prompt("hello");
		await new Promise<void>((r) => driver.once("assistant-final", r));
		const history = await driver.history();
		expect(history.map((h) => h.role)).toEqual(["user", "assistant"]);
		expect(history[1]!.text).toBe("all green: 264 passed");
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
