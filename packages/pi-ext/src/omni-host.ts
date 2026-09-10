// /omni host: boots the pppi gateway INSIDE this pi session (it lives as long
// as the session does). Two agent modes:
//   /omni        — launcher: the omni conversation is a separate `pi --mode
//                  rpc` child this session drives (also `/omni child`)
//   /omni here   — THIS session is the omni: no child, clients mirror exactly
//                  what the terminal shows (guarded when history exists)
// Voice runs in a spawned audio-service child either way, so native STT,
// silero and kokoro never load into pi's process.
//
// Everything the gateway needs resolves from ext/node_modules, which
// `install.mjs` materializes: @pppi/gateway (+protocol/omni), ws/minimatch,
// web dist, and symlinks to this repo's native voice deps when available.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { pairUrl, qrText } from "./pair.ts";
import { ExtensionAgentDriver } from "./session-driver.ts";
import { type PairFile, loadPair, readOmniMark, writePair } from "./store.ts";

type GatewayModule = {
	loadOrCreateConfig: (opts?: Record<string, unknown>) => { token: string; port: number; host: string; cwd: string };
	createGateway: (opts: Record<string, unknown>) => Promise<{
		listen: (port: number, host: string) => Promise<void>;
		close: () => Promise<void>;
	}>;
	RpcAgentDriver: new (opts: { command: string[]; cwd: string }) => {
		start: () => void;
		dispose: () => void;
	};
};

type BootConfig = { token: string; port: number; host: string; cwd: string };
type Notify = (message: string, level?: "info" | "error") => void;

let running: { stop: () => Promise<void> } | null = null;

async function gatewayUp(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`);
		const body = (await res.json()) as { name?: string };
		return body?.name === "pppi";
	} catch {
		return false;
	}
}

async function loadGatewayModule(): Promise<GatewayModule> {
	return (await import("@pppi/gateway")) as unknown as GatewayModule;
}

function extDir(): string {
	// this file lives at <ext>/src/omni-host.ts
	return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Which gateway build this install carries (install.mjs's version.json). */
function versionStamp(): string {
	try {
		const v = JSON.parse(readFileSync(join(extDir(), "version.json"), "utf8")) as {
			sha?: string;
			dirty?: boolean;
		};
		return `gateway ${v.sha ?? "?"}${v.dirty ? " (dirty tree)" : ""}`;
	} catch {
		return "gateway dev build";
	}
}

/** bun runs the .ts audio child natively; without it voice stays unavailable (health shows why). */
function audioCommand(): string[] | null {
	try {
		const bin = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
		if (bin) return [bin, join(extDir(), "node_modules", "@pppi", "gateway", "src", "audio-service.ts")];
	} catch {
		// bun missing → no voice child
	}
	return null;
}

function lanIps(): string[] {
	const out: string[] = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const ni of list ?? []) {
			if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
		}
	}
	return out;
}

/** Stop a gateway this session started (also wired to session_shutdown). */
export async function stopOmniHost(): Promise<void> {
	if (running) {
		const r = running;
		running = null;
		await r.stop();
	}
}

async function prepareBoot(notify: Notify): Promise<{ gw: GatewayModule; cfg: BootConfig } | null> {
	let gw: GatewayModule;
	try {
		gw = await loadGatewayModule();
	} catch {
		notify(
			`@pppi/gateway is not installed for this extension (${join(extDir(), "node_modules")}).\nRun: bun run install:ext`,
			"error",
		);
		return null;
	}
	const cfg = gw.loadOrCreateConfig();
	if (await gatewayUp(cfg.port)) {
		const pair = loadPair();
		notify(`A pppi gateway is already running:\n${pair ? pairUrl(pair) : `http://localhost:${cfg.port}`}`);
		return null;
	}
	return { gw, cfg };
}

/** Bind the gateway, announce pairing, remember how to stop it. */
async function bootGateway(
	notify: Notify,
	gw: GatewayModule,
	cfg: BootConfig,
	agent: unknown,
	start: (() => void) | null,
	label: string,
): Promise<void> {
	const webDist = join(extDir(), "web");
	const audio = audioCommand();
	const gateway = await gw.createGateway({
		token: cfg.token,
		agent: agent as never,
		webDist: existsSync(webDist) ? webDist : undefined,
		audioService: audio ? { command: audio } : undefined,
	});
	try {
		await gateway.listen(cfg.port, cfg.host);
	} catch (err) {
		notify(`Could not bind port ${cfg.port}: ${(err as Error).message}`, "error");
		return;
	}
	start?.();
	running = {
		stop: async () => {
			await gateway.close();
		},
	};

	const pair: PairFile = {
		machine: process.env.PPPI_NAME ?? hostname(),
		port: cfg.port,
		token: cfg.token,
		ips: lanIps(),
		urls: [],
		fingerprint: createHash("sha256").update(cfg.token).digest("hex").slice(0, 8),
	};
	pair.urls = pair.ips.map((ip) => `http://${ip}:${cfg.port}`);
	writePair(pair);
	const qr = qrText(pair);
	const lines = [
		`pppi gateway is up (while this session lives) — ${label}`,
		pair ? `\n${pairUrl(pair)}` : "",
		`\n${versionStamp()}`,
		`\nvoice: ${audio ? "audio service child" : "unavailable (bun not found)"}`,
		"stop: /omni stop — or end this session.",
	];
	notify(lines.filter(Boolean).join("\n") + (qr ? `\n\n${qr}` : ""), "info");
}

/** `/omni` + `/omni child`: launcher form — the omni conversation is an RPC child. */
export async function startOmniHost(notify: Notify): Promise<void> {
	if (running) {
		notify("The pppi gateway is already running from this session — it stops when the session ends.");
		return;
	}
	const prepared = await prepareBoot(notify);
	if (!prepared) return;
	const { gw, cfg } = prepared;

	const omniSession = readOmniMark()?.sessionId ?? "pppi-omni";
	// respawn pi through the same binary that hosts us (PATH may not have `pi`)
	const piEntry = process.argv[1] ?? "pi";
	const omniEntry = join(extDir(), "node_modules", "@pppi", "omni", "src", "extension.ts");
	if (!existsSync(omniEntry)) {
		notify(`The omni tools copy is missing (${omniEntry}).\nRun: bun run install:ext`, "error");
		return;
	}
	const driver = new gw.RpcAgentDriver({
		command: [process.execPath, piEntry, "--mode", "rpc", "--session-id", omniSession, "--no-approve", "-e", omniEntry],
		cwd: cfg.cwd,
	});

	mkdirSync(cfg.cwd, { recursive: true });
	await bootGateway(notify, gw, cfg, driver, () => driver.start(), `omni session: ${omniSession}`);
}

/** `/omni here`: THIS session is the omni — clients mirror what the TUI shows. */
export async function startOmniHere(pi: unknown, ctx: ExtensionCommandContext, notify: Notify): Promise<void> {
	if (running) {
		notify("The pppi gateway is already running from this session — it stops when the session ends.");
		return;
	}
	const prepared = await prepareBoot(notify);
	if (!prepared) return;
	const { gw, cfg } = prepared;

	// guard: a session with a real conversation must not silently become the omni
	const messages = ctx.sessionManager.getEntries().filter((e) => e?.type === "message");
	if (messages.length > 0) {
		const ok = await ctx.ui.confirm(
			"/omni here",
			"This session already has conversation history — clients would share it. Make this session the omni?",
		);
		if (!ok) return;
	}

	const driver = new ExtensionAgentDriver(pi, ctx.cwd);
	driver.setCtx(ctx as never);
	driver.attach();
	driver.refreshStatus();

	await bootGateway(
		notify,
		gw,
		cfg,
		driver,
		null,
		`this session as omni (${driver.info.sessionId?.slice(0, 8) ?? ""}…)`,
	);
}
