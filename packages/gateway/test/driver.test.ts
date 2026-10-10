import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcAgentDriver, toolLabel } from "../src/agent.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "mock-agent.mjs");

/**
 * A minimal `pi --mode rpc` child for framing tests: answers the handshake
 * commands, then writes `extraLine` to stdout — split at byte `splitAt` into
 * two writes `gapMs` apart, so the driver's pipe reads land mid-line and
 * (given a multibyte `extraLine`) mid-codepoint. The split is emitted on the
 * LAST handshake command (`set_auto_compaction`): nothing else the driver
 * sends may interleave stdout into the gap and merge with the halves.
 */
function framingChild(extraLine: string, splitAt: number, gapMs: number): string[] {
	const script = `
		const answers = {
			get_state: { model: { provider: "mock", id: "mock-1", name: "Mock 1", reasoning: false, contextWindow: 10000 }, thinkingLevel: "off", isStreaming: false, sessionName: "omni", sessionId: "framing" },
			get_available_thinking_levels: { levels: ["off"] },
			get_session_stats: { contextUsage: { tokens: 1, contextWindow: 10000, percent: 0.01 } },
			set_auto_compaction: {},
		};
		let buf = "";
		let sent = false;
		process.stdin.on("data", (chunk) => {
			buf += chunk;
			for (;;) {
				const nl = buf.indexOf("\\n");
				if (nl === -1) break;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				const cmd = JSON.parse(line);
				const data = answers[cmd.type] ?? {};
				process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, data }) + "\\n");
				if (cmd.type === "set_auto_compaction" && !sent) {
					sent = true;
					const bytes = Buffer.from(${JSON.stringify(extraLine)}, "utf8");
					const at = Math.max(1, Math.min(${splitAt}, bytes.length));
					process.stdout.write(bytes.subarray(0, at));
					setTimeout(() => process.stdout.write(bytes.subarray(at)), ${gapMs});
				}
			}
		});
		process.stdin.on("end", () => process.exit(0));
	`;
	return [process.execPath, "-e", script];
}

describe("rpc agent driver", () => {
	let driver: RpcAgentDriver;

	beforeEach(() => {
		process.env.MOCK_REPLY = "all green: 264 passed";
		driver = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
	});

	afterEach(async () => {
		driver.dispose();
		process.env.MOCK_DIALOG = undefined;
		process.env.PPPI_DIALOG_HOLD_MS = undefined;
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

	it("labels pi 1.x built-in and mcp tool calls for the status line", () => {
		expect(toolLabel("codemode", {})).toBe("running a script");
		expect(toolLabel("mcp__github__create_issue", {})).toBe("running create_issue");
		expect(toolLabel("omni_repos", {})).toBe("coordinating");
	});

	it("a handled prompt notifies instead of waiting for a turn", async () => {
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		const notified = new Promise<string>((r) => driver.once("notify", (_level, message) => r(message)));
		await driver.prompt("/pppi_profile");
		expect(await notified).toMatch(/handled/);
		expect(driver.state).toBe("idle");
	});

	it("shows waiting while the agent needs a human, then auto-dismisses", async () => {
		process.env.MOCK_DIALOG = "1";
		process.env.PPPI_DIALOG_HOLD_MS = "80";
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
		const states: string[] = [];
		const notified = new Promise<string>((r) => driver.once("notify", (_l, m) => r(m)));
		driver.on("state", (s) => states.push(s));
		const done = new Promise<void>((r) => driver.once("assistant-final", r));
		await driver.prompt("hello");
		await done;
		// the mock emits synchronously — idle may already have fired
		if (driver.state !== "idle") {
			await new Promise<void>((r, j) => {
				const timer = setTimeout(() => j(new Error("never settled to idle")), 5_000);
				driver.on("state", (s) => {
					if (s === "idle") {
						clearTimeout(timer);
						r();
					}
				});
			});
		}
		expect(states).toContain("waiting");
		expect(await notified).toMatch(/needs you/);
		// after the dismissal the turn ran to completion — back to business
		expect(driver.state).toBe("idle");
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

	it("reassembles rpc lines whose utf-8 bytes split mid-codepoint across pipe reads", async () => {
		const line = `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "X好Y" } })}\n`;
		const bytes = Buffer.from(line, "utf8");
		const x = bytes.indexOf("X");
		const cut = x + 2; // after the lead byte of 好 (a 3-byte code point)
		expect(x).toBeGreaterThan(-1);
		expect(bytes[cut]! & 0xc0).toBe(0x80); // the second read starts mid-codepoint

		driver = new RpcAgentDriver({ command: framingChild(line, cut, 40), cwd: "/tmp" });
		const deltas: string[] = [];
		driver.on("assistant-delta", (_id, d) => deltas.push(d));
		driver.start();
		await new Promise<void>((r, j) => {
			const timer = setTimeout(() => j(new Error("never ready")), 10_000);
			driver.once("ready", () => {
				clearTimeout(timer);
				r();
			});
		});
		await new Promise<void>((r, j) => {
			const timer = setTimeout(() => j(new Error("split line never reassembled into a delta")), 10_000);
			driver.once("assistant-delta", () => {
				clearTimeout(timer);
				r();
			});
		});
		expect(deltas.join("")).toBe("X好Y");
	});

	it("logs and drops an unparseable rpc line, then keeps parsing", async () => {
		const noise = "*** stdout noise: definitely not a json line\n";
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			driver = new RpcAgentDriver({ command: framingChild(noise, noise.length, 0), cwd: "/tmp" });
			driver.start();
			await new Promise<void>((r, j) => {
				const timer = setTimeout(() => j(new Error("never ready")), 10_000);
				driver.once("ready", () => {
					clearTimeout(timer);
					r();
				});
			});
			// ready fires before the child has processed the trigger command
			await vi.waitFor(() =>
				expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropping unparseable rpc line")),
			);
		} finally {
			warn.mockRestore();
		}
	});
});
