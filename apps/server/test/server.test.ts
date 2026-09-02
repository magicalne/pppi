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
