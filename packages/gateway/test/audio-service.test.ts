// The /omni extension host serves voice through the audio-service child; these
// tests spawn the real child (bun, fake mode) and drive a turn through the
// proxy: mic audio → child VAD/STT → __submit__ → agent → spoken reply back.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
		expect(["starting", "ready", "unavailable"]).toContain(body.boot?.stage);
	});

	it("sends the boot story to voice clients before hello_ok", async () => {
		// works warm or cold: the proxy keeps the boot history and replays it at attach.
		// the listener goes on BEFORE open — the frames ride the upgrade, so they can
		// arrive in the same burst as the open event
		const frames: Array<{ component: string; stage: string; reason?: string }> = [];
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(`${base}/voice`);
			const timer = setTimeout(() => reject(new Error("no hello_ok within 15s")), 15_000);
			ws.on("message", (raw: Buffer) => {
				let evt: any;
				try {
					evt = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (evt.type === "__voice_boot__") frames.push(evt);
				if (evt.type === "voice_hello_ok") {
					clearTimeout(timer);
					ws.close();
					resolve();
				}
			});
			ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, client: "test" })));
			ws.on("error", reject);
		});
		expect(frames.some((f) => f.component === "vad")).toBe(true);
		expect(frames.some((f) => f.component === "stt" && f.stage === "ready")).toBe(true);
		// fake child has no tts — the boot story says so honestly
		expect(frames.some((f) => f.component === "tts" && f.stage === "failed")).toBe(true);
	});

	it("turns spoken audio from the child into a chat turn and speaks the reply", async () => {
		const chat = await connect("/ws", token);
		await nextEvent(chat, "hello_ok");

		// attach before hello: the child authes fast, and voice_active precedes hello_ok
		const userMessage = nextEvent(chat, "user_message");
		const final = nextEvent(chat, "assistant_final");
		const voiceActive = nextEvent(chat, "voice_active");
		const voice = await connect("/voice", token);

		// speech long enough to open an utterance, then trailing silence to close
		// it: endpoint (0.9s) + grace (1.2s) before the turn dispatches
		await say(voice, true, 0.9);
		await say(voice, false, 2.5);

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

// PPPI_AUDIO_NO_STT=1 boots the service WITHOUT native STT — sessions still
// connect and hear the honest not-ready status. Regression: the wiring used to
// be `voiceStt(null!)`, a TypeError at module scope that killed the child
// before it could print anything.
describe.skipIf(!bunBin)("audio service without native STT", () => {
	it("boots with PPPI_AUDIO_NO_STT=1, reports stt honestly, and serves sessions", async () => {
		const child: ChildProcess = spawn(bunBin!, [audioEntry], {
			env: { ...process.env, PPPI_AUDIO_TOKEN: "no-stt-token", PPPI_AUDIO_NO_STT: "1", PPPI_AUDIO_FAKE: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const bootFrames: Array<{ component: string; stage: string; reason?: string }> = [];
		const info = await new Promise<any>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`no ready line in 45s; boot: ${JSON.stringify(bootFrames)}`)),
				45_000,
			);
			let buf = "";
			child.stdout!.on("data", (chunk: Buffer) => {
				buf += chunk.toString("utf8");
				let nl = buf.indexOf("\n");
				while (nl !== -1) {
					const line = buf.slice(0, nl).replace(/\r$/, "");
					buf = buf.slice(nl + 1);
					nl = buf.indexOf("\n");
					try {
						const parsed = JSON.parse(line);
						if (parsed.ev === "boot") {
							bootFrames.push(parsed);
							continue;
						}
						if (typeof parsed.port === "number") {
							clearTimeout(timer);
							resolve(parsed);
							return;
						}
					} catch {
						// not JSON — ignore
					}
				}
			});
			child.on("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`audio-service child exited early (code ${code}) — boot crash?`));
			});
		});

		try {
			// the ready line tells the truth: stt is disabled, not ready
			expect(info.stt).toEqual({ ready: false, reason: "stt disabled" });
			// the boot story names the mode (the branch existed but was dead code before)
			expect(bootFrames).toContainEqual({ ev: "boot", component: "stt", stage: "failed", reason: "STT disabled" });

			// a voice session still connects and hears the honest status
			const hello = await new Promise<any>((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${info.port}/voice`);
				const timer = setTimeout(() => reject(new Error("no voice_hello_ok in 10s")), 10_000);
				ws.on("message", (raw: Buffer, isBinary: boolean) => {
					if (isBinary) return;
					try {
						const evt = JSON.parse(raw.toString());
						if (evt.type === "voice_hello_ok") {
							clearTimeout(timer);
							ws.close();
							resolve(evt);
						}
					} catch {
						// not ours
					}
				});
				ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: "no-stt-token" })));
				ws.on("error", reject);
			});
			expect(hello.stt).toEqual({ ready: false, reason: "stt disabled" });
		} finally {
			child.kill("SIGTERM");
			await new Promise<void>((r) => {
				child.on("exit", () => r());
				setTimeout(() => {
					child.kill("SIGKILL");
					r();
				}, 3_000);
			});
		}
	}, 60_000);
});
