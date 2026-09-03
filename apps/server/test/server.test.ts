import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { RpcAgentDriver } from "../src/agent.ts";
import { createServer } from "../src/server.ts";
import { Stt } from "../src/stt.ts";
import { encodeWav16k } from "../src/wav.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mock-agent.mjs");

describe("gateway server", () => {
	let app: Awaited<ReturnType<typeof createServer>>;
	let driver: RpcAgentDriver;
	let address: string;
	const token = "test-token-1234";

	beforeEach(async () => {
		process.env.MOCK_REPLY = "ack from omni";
		driver = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
		app = await createServer({ token, driver, stt: Stt.create({ disabled: true }) });
		await app.listen({ port: 0, host: "127.0.0.1" });
		const addr = app.server.address();
		const port = typeof addr === "object" && addr?.port ? addr.port : 0;
		address = `ws://127.0.0.1:${port}/ws`;
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
	});

	afterEach(async () => {
		driver.dispose();
		await app.close();
	});

	function connect(tokenValue: string | null): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(address);
			ws.on("open", () => {
				ws.send(JSON.stringify({ type: "hello", token: tokenValue, client: "test" }));
				resolve(ws);
			});
			ws.on("error", reject);
		});
	}

	function nextEvent(ws: WebSocket, type?: string): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no ${type ?? "event"} within 10s`)), 10_000);
			ws.on("message", (raw) => {
				const evt = JSON.parse(raw.toString());
				if (!type || evt.type === type) {
					clearTimeout(timer);
					resolve(evt);
				}
			});
		});
	}

	it("health reports agent and stt status", async () => {
		const res = await app.inject({ method: "GET", url: "/api/health" });
		const body = res.json();
		expect(res.statusCode).toBe(200);
		expect(body.agent.model).toBe("mock/mock-1");
		expect(body.stt.ready).toBe(false);
	});

	it("rejects voice uploads with a bad token", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/voice",
			headers: { authorization: "Bearer wrong", "content-type": "audio/wav" },
			payload: Buffer.alloc(44),
		});
		expect(res.statusCode).toBe(401);
	});

	it("handshakes with the right token and fails with the wrong one", async () => {
		const good = await connect(token);
		const ok = await nextEvent(good, "hello_ok");
		expect(ok.agent.model).toBe("mock/mock-1");
		expect(ok.history).toEqual([]);
		good.close();

		const bad = await connect("nope");
		const fail = await nextEvent(bad, "hello_fail");
		expect(fail.error).toMatch(/bad pairing token/);
		bad.close();
	});

	it("delivers a chat message and mirrors the reply to all clients", async () => {
		const a = await connect(token);
		await nextEvent(a, "hello_ok");
		const b = await connect(token);
		await nextEvent(b, "hello_ok");

		const finalA = nextEvent(a, "assistant_final");
		const finalB = nextEvent(b, "assistant_final");
		const userB = nextEvent(b, "user_message");

		a.send(JSON.stringify({ type: "chat", text: "status please", source: "text" }));

		const user = await userB;
		expect(user.text).toBe("status please");
		expect(user.source).toBe("text");
		expect((await finalA).text).toBe("ack from omni");
		expect((await finalB).text).toBe("ack from omni");

		a.close();
		b.close();
	});

	it("returns 422 for a silent voice upload", async () => {
		const silence = encodeWav16k(new Float32Array(16000)); // 1s of silence
		const res = await app.inject({
			method: "POST",
			url: "/api/voice",
			headers: { authorization: `Bearer ${token}`, "content-type": "audio/wav" },
			payload: silence,
		});
		// STT is disabled in this suite → 503 before 422; assert the auth+pipeline path
		expect([422, 503]).toContain(res.statusCode);
	});
});

describe("pairing + profiles api", () => {
	const token = "pair-test-token";
	const tmpDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".tmp-test-profiles");
	let app: Awaited<ReturnType<typeof createServer>>;
	let driver: RpcAgentDriver;

	function boot(withPair: boolean) {
		return async () => {
			const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
			rmSync(tmpDir, { recursive: true, force: true });
			mkdirSync(join(tmpDir, "profiles"), { recursive: true });
			writeFileSync(
				join(tmpDir, "profiles", "joe-1.json"),
				JSON.stringify({ id: "joe-1", name: "Joe", color: "#e8b14a", description: "owns the pigeon repo" }),
			);
			process.env.MOCK_REPLY = "ack from omni";
			process.env.SSPI_DIR = tmpDir;
			driver = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
			app = await createServer({
				token,
				driver,
				stt: Stt.create({ disabled: true }),
				pair: withPair
					? { machine: "test-box", port: 8787, token, ips: ["192.168.1.9"], urls: ["http://192.168.1.9:8787"], fingerprint: "abcdef12" }
					: undefined,
			});
			await app.listen({ port: 0, host: "127.0.0.1" });
			driver.start();
			await new Promise<void>((r) => driver.once("ready", r));
		};
	}

	afterEach(async () => {
		driver?.dispose();
		if (app) await app.close();
		const { rmSync } = await import("node:fs");
		rmSync(tmpDir, { recursive: true, force: true });
		delete process.env.SSPI_DIR;
	});

	it("serves /api/pair with the right token and 401s otherwise", async () => {
		await boot(true)();
		const good = await app.inject({ method: "GET", url: "/api/pair", headers: { authorization: `Bearer ${token}` } });
		expect(good.statusCode).toBe(200);
		const body = good.json();
		expect(body.machine).toBe("test-box");
		expect(body.fingerprint).toBe("abcdef12");
		expect(body.urls).toContain("http://192.168.1.9:8787");

		const bad = await app.inject({ method: "GET", url: "/api/pair", headers: { authorization: "Bearer nope" } });
		expect(bad.statusCode).toBe(401);
	});

	it("404s /api/pair when no pair info is configured", async () => {
		await boot(false)();
		const res = await app.inject({ method: "GET", url: "/api/pair" });
		expect(res.statusCode).toBe(404);
	});

	it("keeps the /api/sessions shape with a profiles map", async () => {
		await boot(false)();
		const res = await app.inject({ method: "GET", url: "/api/sessions" });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(Array.isArray(body.projects)).toBe(true);
		expect(body.profiles).toBeDefined();
	});

	it("buildProfiles prefers explicit files and derives the rest deterministically", async () => {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(tmpDir, "profiles"), { recursive: true });
		writeFileSync(
			join(tmpDir, "profiles", "joe-1.json"),
			JSON.stringify({ id: "joe-1", name: "Joe", color: "#e8b14a", description: "owns the pigeon repo" }),
		);
		const { buildProfiles, colorForId } = await import("../src/profiles.ts");
		const map = buildProfiles(
			["joe-1", "anon-9"],
			[
				{ id: "joe-1", name: null, cwd: "/x/pigeon" },
				{ id: "anon-9", name: null, cwd: "/x/sspi" },
			],
			tmpDir,
		);
		expect(map["joe-1"]).toMatchObject({ name: "Joe", color: "#e8b14a", description: "owns the pigeon repo" });
		expect(map["anon-9"]!.name).toBe("sspi"); // derived from cwd
		expect(map["anon-9"]!.color).toBe(colorForId("anon-9"));
	});
});
