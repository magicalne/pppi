// Parent side of the audio service: spawns the child, reads its ready line,
// and lets the gateway serve voice through it — /voice sockets become
// transparent pipes with control frames ("__submit__", "__abort__",
// "__voice_active__") intercepted and turned into gateway callbacks, and
// hold-to-talk uploads forward to the child's /transcribe.

import { type ChildProcess, spawn } from "node:child_process";
import { request } from "node:http";
import type { WebSocket as WsSocket } from "ws";

export type AudioServiceOptions = {
	/** How to run the child, e.g. ["bun", "<ext>/node_modules/@pppi/gateway/src/audio-service.ts"]. */
	command: string[];
	token: string;
	env?: Record<string, string | undefined>;
};

export type AudioBootStage = "starting" | "ready" | "unavailable";

export type AudioHealth = {
	stt: { ready: true; modelId: string } | { ready: false; reason: string };
	tts: { ready: true; provider: string; voice: string } | { ready: false; reason: string };
	vad: boolean;
	boot: { stage: AudioBootStage; reason?: string };
};

type Info = { port: number; stt: AudioHealth["stt"]; tts: AudioHealth["tts"]; vad: boolean };
type BootFrame = { ev: "boot"; component: string; stage: string; reason?: string };

export class AudioService {
	private child: ChildProcess | null = null;
	private info: Info | null = null;
	private starting: Promise<boolean> | null = null;
	private lastStderr = "";
	private ups = new Set<WsSocket>();
	private authedUps = new Set<WsSocket>();
	private bootFrames: BootFrame[] = [];
	private bootListeners = new Set<(f: BootFrame) => void>();
	private lastBootReason: string | null = null;

	constructor(
		private opts: AudioServiceOptions & {
			submit: (text: string) => Promise<void>;
			abortAgent: () => void;
			setVoiceActive: (active: boolean) => void;
		},
	) {}

	/** True once the child is up (respawns after a crash on the next call). */
	async ensure(): Promise<boolean> {
		if (this.info) return true;
		if (!this.starting) {
			this.starting = this.start()
				.catch(() => false)
				.then((ok) => {
					this.starting = null;
					return ok;
				});
		}
		return this.starting;
	}

	private start(): Promise<boolean> {
		return new Promise((resolve) => {
			const [cmd, ...args] = this.opts.command;
			if (!cmd) return resolve(false);
			// a respawn starts a fresh boot story
			this.bootFrames = [];
			this.lastBootReason = null;
			let child: ChildProcess;
			try {
				child = spawn(cmd, args, {
					env: { ...process.env, ...this.opts.env, PPPI_AUDIO_TOKEN: this.opts.token },
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch {
				return resolve(false);
			}
			this.child = child;
			const timer = setTimeout(() => fail("audio service start timeout"), 120_000);
			const fail = (why: string) => {
				this.lastStderr = why;
				cleanup();
				child.kill("SIGTERM");
				resolve(false);
			};
			const onOut = (chunk: Buffer) => {
				buf += chunk.toString("utf8");
				// strict JSONL: split on \n only; the last element may be a partial line
				let nl = buf.indexOf("\n");
				while (nl !== -1) {
					const line = buf.slice(0, nl).replace(/\r$/, "");
					buf = buf.slice(nl + 1);
					let parsed: (Info & { ev?: string }) | BootFrame | null = null;
					try {
						parsed = JSON.parse(line) as Info | BootFrame;
					} catch {
						parsed = null;
					}
					if (parsed && (parsed as BootFrame).ev === "boot") {
						const frame = parsed as BootFrame;
						if (frame.stage === "failed" && frame.reason) this.lastBootReason = frame.reason;
						this.bootFrames.push(frame);
						for (const l of this.bootListeners) l(frame);
						nl = buf.indexOf("\n");
						continue;
					}
					const info = parsed as Info | null;
					if (!info || typeof info.port !== "number") {
						fail("audio service printed garbage instead of a ready line");
						return;
					}
					this.info = info;
					clearTimeout(timer);
					cleanup();
					resolve(true);
					nl = buf.indexOf("\n");
				}
			};
			const onErr = (chunk: Buffer) => {
				this.lastStderr = chunk.toString("utf8").trim().split("\n").at(-1) ?? this.lastStderr;
			};
			const onExit = (code: number | null) => {
				this.info = null;
				this.child = null;
				if (!done) fail(`audio service exited (code ${code ?? "?"})`);
			};
			let buf = "";
			let done = false;
			const cleanup = () => {
				done = true;
				child.stdout?.off("data", onOut);
				child.stderr?.off("data", onErr);
				child.off("exit", onExit);
			};
			child.stdout?.on("data", onOut);
			child.stderr?.on("data", onErr);
			child.on("exit", onExit);
		});
	}

	health(): AudioHealth {
		const boot: AudioHealth["boot"] = this.info
			? { stage: "ready" }
			: this.starting
				? { stage: "starting", ...(this.lastBootReason ? { reason: this.lastBootReason } : {}) }
				: { stage: "unavailable", reason: this.lastStderr || "audio service unavailable" };
		if (this.info) return { stt: this.info.stt, tts: this.info.tts, vad: this.info.vad, boot };
		return {
			stt: { ready: false, reason: this.lastStderr || "audio service unavailable" },
			tts: { ready: false, reason: "audio service unavailable" },
			vad: false,
			boot,
		};
	}

	/** Batch hold-to-talk transcription against the child. */
	async transcribe(body: Buffer): Promise<string> {
		if (!(await this.ensure()) || !this.info) throw new Error("audio service unavailable");
		const transcript = await new Promise<string>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: this.info!.port,
					method: "POST",
					path: "/transcribe",
					headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "audio/wav" },
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						try {
							const body = JSON.parse(Buffer.concat(chunks).toString()) as { transcript?: string; error?: string };
							if (res.statusCode !== 200) reject(new Error(body.error ?? `transcribe failed (${res.statusCode})`));
							else resolve(body.transcript ?? "");
						} catch (err) {
							reject(err as Error);
						}
					});
				},
			);
			req.on("error", reject);
			req.end(body);
		});
		return transcript;
	}

	/** Pipe a client /voice socket to the child, intercepting control frames. */
	async proxyVoice(client: WsSocket): Promise<void> {
		// attach the client listener SYNCHRONOUSLY: the child spawn below is
		// async, and the client's hello (or first audio) can beat it — those
		// frames buffer here until the upstream socket is open
		const pending: Array<{ data: Buffer; isBinary: boolean }> = [];
		let up: WsSocket | null = null;
		let gone = false;
		client.on("message", (data: Buffer, isBinary: boolean) => {
			if (up && up.readyState === up.OPEN) up.send(data, { binary: isBinary });
			else pending.push({ data, isBinary });
		});
		client.on("close", () => {
			gone = true;
			up?.close();
		});
		// boot progress first — even if the child is already warm, the history
		// tells the client what happened (and arrives before its hello_ok)
		const onBoot = (f: BootFrame) => {
			try {
				client.send(
					JSON.stringify({
						type: "__voice_boot__",
						component: f.component,
						stage: f.stage,
						...(f.reason ? { reason: f.reason } : {}),
					}),
					{
						binary: false,
					},
				);
			} catch {
				// client gone mid-boot
			}
		};
		this.bootListeners.add(onBoot);
		for (const f of this.bootFrames) onBoot(f);
		if (!(await this.ensure()) || !this.info || gone) {
			this.bootListeners.delete(onBoot);
			client.close();
			return;
		}
		this.bootListeners.delete(onBoot); // child is warm; no more frames coming
		const { WebSocket } = await import("ws");
		up = new WebSocket(`ws://127.0.0.1:${this.info!.port}/voice`);
		const sock = up;
		const tearDown = () => {
			this.ups.delete(sock);
			// the child can't announce a client hang-up (its socket is already
			// closing when onClosed fires), so the parent owns the active count
			if (this.authedUps.delete(sock)) this.opts.setVoiceActive(this.authedUps.size > 0);
			try {
				client.close();
			} catch {
				// already gone
			}
			try {
				up.close();
			} catch {
				// already gone
			}
		};
		sock.on("open", () => {
			this.ups.add(sock);
			// flush whatever the client sent while the child was starting
			for (const f of pending.splice(0)) sock.send(f.data, { binary: f.isBinary });
		});
		sock.on("message", (data: Buffer, isBinary: boolean) => {
			if (isBinary) return client.send(data, { binary: true });
			let evt: { type?: string; text?: string; active?: boolean };
			try {
				evt = JSON.parse(data.toString());
			} catch {
				return client.send(data, { binary: false });
			}
			switch (evt.type) {
				case "__submit__":
					void this.opts.submit(evt.text ?? "");
					return;
				case "__abort__":
					this.opts.abortAgent();
					return;
				case "__voice_active__":
					this.opts.setVoiceActive(evt.active === true);
					return;
				case "voice_hello_ok":
					this.authedUps.add(sock);
					return client.send(data, { binary: false });
				default:
					return client.send(data, { binary: false });
			}
		});
		for (const ws of [client, sock]) {
			ws.on("close", tearDown);
			ws.on("error", tearDown);
		}
	}

	/** Assistant text reaches the child's TTS via control frames. */
	assistantDelta(id: string, delta: string): void {
		this.toChild({ type: "__assistant_delta__", id, delta });
	}

	assistantFinal(id: string, text: string): void {
		this.toChild({ type: "__assistant_final__", id, text });
	}

	private toChild(frame: object): void {
		const line = JSON.stringify(frame);
		for (const up of this.ups) {
			if (up.readyState === up.OPEN) up.send(line, { binary: false });
		}
	}

	close(): void {
		this.child?.kill("SIGTERM");
		this.child = null;
		this.info = null;
	}
}
