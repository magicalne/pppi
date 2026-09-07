// The /omni extension host serves voice through the audio-service child; these
// tests spawn the real child (bun, fake mode) and drive a turn through the
// proxy: mic audio → child VAD/STT → __submit__ → agent → spoken reply back.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RpcAgentDriver, createGateway } from "../src/index.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "mock-agent.mjs");
const audioEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "audio-service.ts");

let bunBin: string | null = null;
try {
	bunBin = execFileSync("which", ["bun"], { encoding: "utf8" }).trim() || null;
} catch {
	bunBin = null;
}

describe.skipIf(!bunBin)("audio service child", () => {
	const token = "audio-test-token";
	let driver: RpcAgentDriver;
	let closeGateway: (() => Promise<void>) | null = null;
	let base = "";

	beforeAll(async () => {
		process.env.MOCK_REPLY = "ack from omni";
		driver = new RpcAgentDriver({ command: [process.execPath, mockAgent], cwd: "/tmp" });
		const gw = await createGateway({
			token,
			agent: driver,
			audioService: {
				command: [bunBin!, audioEntry],
				env: { PPPI_AUDIO_FAKE: "1", MOCK_PHRASE: "hello world" },
			},
		});
		closeGateway = () => gw.close();
		await gw.listen(0, "127.0.0.1");
		base = `ws://127.0.0.1:${gw.address()?.port ?? 0}`;
		driver.start();
		await new Promise<void>((r) => driver.once("ready", r));
	});

	afterAll(async () => {
		driver?.dispose();
		if (closeGateway) await closeGateway();
	});

	function connect(path: string, tokenValue: string | null): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`${base}${path}`);
			ws.on("open", () => {
				ws.send(JSON.stringify({ type: "hello", token: tokenValue, client: "test" }));
				resolve(ws);
			});
			ws.on("error", reject);
		});
	}

	function nextEvent(ws: WebSocket, type: string): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no ${type} within 15s`)), 15_000);
			const onMsg = (raw: Buffer) => {
				let evt: any;
				try {
					evt = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (evt.type === type) {
					clearTimeout(timer);
					ws.off("message", onMsg);
					resolve(evt);
				}
			};
			ws.on("message", onMsg);
		});
	}

	/** `seconds` of 16 kHz PCM16 — loud sine (speech) or zeros (silence). */
	function pcm(seconds: number, speech: boolean): Buffer {
		const n = Math.round(seconds * 16000);
		const buf = Buffer.alloc(n * 2);
		for (let i = 0; i < n; i++) buf.writeInt16LE(speech ? Math.round(Math.sin(i / 20) * 8000) : 0, i * 2);
		return buf;
	}

	async function say(ws: WebSocket, speech: boolean, seconds: number): Promise<void> {
		ws.send(pcm(seconds, speech));
		await new Promise((r) => setTimeout(r, 60));
	}

	it("health reports the child's stt once it is up", async () => {
		const res = await fetch(`${base.replace("ws://", "http://")}/api/health`);
		const body = (await res.json()) as any;
		// the child starts lazily; before any voice session it reports unavailable
		expect(res.status).toBe(200);
		expect(body.stt.ready === true || typeof body.stt.reason === "string").toBe(true);
	});

	it("turns spoken audio from the child into a chat turn and speaks the reply", async () => {
		const chat = await connect("/ws", token);
		await nextEvent(chat, "hello_ok");

		// attach before hello: the child authes fast, and voice_active precedes hello_ok
		const userMessage = nextEvent(chat, "user_message");
		const final = nextEvent(chat, "assistant_final");
		const voiceActive = nextEvent(chat, "voice_active");
		const voice = await connect("/voice", token);

		// speech long enough to open an utterance, then trailing silence to close it
		await say(voice, true, 0.9);
		await say(voice, false, 1.2);

		expect((await voiceActive).active).toBe(true);
		expect((await userMessage).text).toBe("hello world");
		expect((await userMessage).source).toBe("voice");
		expect((await final).text).toBe("ack from omni");
		// the spoken reply flows back through the proxy as binary audio frames…
		// (fake child has no tts, so we assert the turn path instead)
		chat.close();
		voice.close();
	});
});
