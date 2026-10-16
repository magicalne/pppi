// Standalone gateway host tests (#30) — the entrypoint pieces the systemd
// unit runs: argument/omni-mark/agent-cmd resolution (lib.ts), and a real
// spawn of apps/server/src/cli.ts asserting the health shape, pair-file
// parity with config.json, and clean SIGTERM shutdown.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { markedOmniSession, parseArgs, resolveAgentCmd, resolvePiBinary } from "../src/lib.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.ts");
const mockAgent = join(here, "..", "..", "..", "packages", "gateway", "test", "mock-agent.mjs");

const tmps: string[] = [];
function tempDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tmps.push(d);
	return d;
}
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe("parseArgs", () => {
	it("parses valued flags, the boolean --no-stt, and skips non-flags", () => {
		expect(parseArgs(["--port", "9000", "--no-stt", "stray", "--host", "0.0.0.0"])).toEqual({
			port: "9000",
			host: "0.0.0.0",
			"no-stt": true,
		});
	});
	it("tolerates a missing value", () => {
		expect(parseArgs(["--token"])).toEqual({ token: "" });
	});
});

describe("markedOmniSession", () => {
	it("returns null without omni.json, reads the id when present, and survives broken files", () => {
		const dir = tempDir("pppi-lib-");
		expect(markedOmniSession(dir)).toBeNull();

		writeFileSync(join(dir, "omni.json"), JSON.stringify({ sessionId: "abc-123" }));
		expect(markedOmniSession(dir)).toBe("abc-123");

		writeFileSync(join(dir, "omni.json"), "{not json");
		expect(markedOmniSession(dir)).toBeNull();

		writeFileSync(join(dir, "omni.json"), JSON.stringify({ sessionId: "" }));
		expect(markedOmniSession(dir)).toBeNull();
	});
});

describe("resolvePiBinary", () => {
	it("prefers the pi sitting next to the running bun (systemd has no PATH)", () => {
		const bin = tempDir("ppi-bin-");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(bin, "bun"), "", { mode: 0o755 });
		expect(resolvePiBinary({ HOME: "/nonexistent" }, join(bin, "bun"))).toBe(join(bin, "pi"));
	});
	it("falls back to $HOME/.bun/bin/pi, then bare pi", () => {
		const home = tempDir("ppi-home-");
		mkdirSync(join(home, ".bun", "bin"), { recursive: true });
		writeFileSync(join(home, ".bun", "bin", "pi"), "#!/bin/sh\n", { mode: 0o755 });
		expect(resolvePiBinary({ HOME: home }, "/usr/local/bin/bun")).toBe(join(home, ".bun", "bin", "pi"));
		expect(resolvePiBinary({ HOME: "/nonexistent" }, "/nowhere/bun")).toBe("pi");
	});
});

describe("resolveAgentCmd", () => {
	it("defaults to an rpc-mode pi resuming the marked session with the omni extension", () => {
		expect(
			resolveAgentCmd(undefined, "sess-9", "/repo/extensions/omni.ts", { HOME: "/nonexistent" }, "/nowhere/bun"),
		).toEqual(["pi", "--mode", "rpc", "--session-id", "sess-9", "--no-approve", "-e", "/repo/extensions/omni.ts"]);
	});
	it("resolves the pi binary absolutely so the spawn survives PATH-less parents", () => {
		const bin = tempDir("ppi-bin-");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\n", { mode: 0o755 });
		const cmd = resolveAgentCmd(
			undefined,
			"sess-9",
			"/repo/extensions/omni.ts",
			{ HOME: "/nonexistent" },
			join(bin, "bun"),
		);
		expect(cmd[0]).toBe(join(bin, "pi"));
	});
	it("an explicit --agent-cmd wins wholesale", () => {
		expect(resolveAgentCmd("node /x/mock-agent.mjs", "sess-9", "/repo/extensions/omni.ts")).toEqual([
			"node",
			"/x/mock-agent.mjs",
		]);
	});
});

describe("standalone CLI (spawned, temp PPPI_DIR)", () => {
	let child: ReturnType<typeof spawn> | null = null;

	afterEach(() => {
		if (child && child.exitCode === null) child.kill("SIGKILL");
		child = null;
	});

	function freePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const net = require("node:net") as typeof import("node:net");
			const srv = net.createServer();
			srv.listen(0, "127.0.0.1", () => {
				const p = (srv.address() as { port: number }).port;
				srv.close(() => resolve(p));
			});
			srv.on("error", reject);
		});
	}

	async function waitHealthy(port: number, timeoutMs = 20_000): Promise<any> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/api/health`);
				if (res.ok) {
					const body = await res.json();
					// wait for the agent child to report in too (driver start is async)
					if (typeof body.agent?.model === "string") return body;
				}
			} catch {
				// not up yet
			}
			if (Date.now() > deadline) throw new Error("standalone gateway never became healthy");
			await new Promise((r) => setTimeout(r, 300));
		}
	}

	it("serves the same health shape, writes pair.json matching config.json, and exits cleanly on SIGTERM", async () => {
		const dir = tempDir("pppi-standalone-");
		mkdirSync(join(dir, "omni-home"), { recursive: true });
		const port = await freePort();

		// the CLI is TypeScript: run it with bun (vitest workers may sit on node,
		// whose strip-only TS mode rejects parameter properties)
		const bunBin = process.execPath.includes("bun") ? process.execPath : "bun";
		child = spawn(
			bunBin,
			[
				cli,
				"--port",
				String(port),
				"--host",
				"127.0.0.1",
				"--no-stt",
				"--cwd",
				join(dir, "omni-home"),
				"--agent-cmd",
				`${process.execPath} ${mockAgent}`,
			],
			{
				env: { ...process.env, PPPI_DIR: dir, HOME: dir, MOCK_REPLY: "ack from omni" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		// capture child output so a never-healthy failure explains itself
		const out: string[] = [];
		for (const stream of [child.stdout, child.stderr]) {
			if (stream) stream.on("data", (d) => out.push(String(d)));
		}
		child.once("exit", (c, sig) => out.push(`[child exited code=${c} signal=${sig}]`));
		let health: any;
		try {
			health = await waitHealthy(port);
		} catch (err) {
			throw new Error(`${(err as Error).message}\nchild output:\n${out.join("").slice(0, 3000)}`);
		}
		// the same shape the hosted gateway serves (server.test.ts pins the blocks)
		expect(health.ok).toBe(true);
		expect(health.name).toBe("pppi");
		expect(typeof health.gateway?.version).toBe("string");
		expect(typeof health.agent?.model).toBe("string");
		expect(health.stt).toMatchObject({ ready: false });
		expect(typeof health.stt.reason).toBe("string");
		expect(health.tts).toBeDefined();
		expect(health.boot).toBeDefined();

		// pairing parity: pair.json carries the config token
		const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { token: string };
		const pair = JSON.parse(readFileSync(join(dir, "pair.json"), "utf8")) as { token: string; port: number };
		expect(existsSync(join(dir, "config.json"))).toBe(true);
		expect(pair.token).toBe(config.token);
		expect(pair.port).toBe(port);

		// SIGTERM (what systemd sends) is a clean shutdown
		const code = await new Promise<number | null>((resolve) => {
			child!.once("exit", (c) => resolve(c));
			child!.kill("SIGTERM");
		});
		expect(code).toBe(0);
		child = null;
	}, 30_000);
});
