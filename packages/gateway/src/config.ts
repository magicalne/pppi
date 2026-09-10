// Server config + pairing token. The token is the only credential a phone or
// browser needs: LLM provider keys and everything else stay on this machine.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ServerConfig = {
	configPath: string;
	token: string;
	port: number;
	host: string;
	cwd: string;
};

export function pppiDir(): string {
	return process.env.PPPI_DIR ?? join(homedir(), ".pppi");
}

export function loadOrCreateConfig(
	opts: { port?: number; host?: string; token?: string; cwd?: string } = {},
): ServerConfig {
	const dir = pppiDir();
	const path = join(dir, "config.json");
	let stored: { token?: string; port?: number; host?: string } = {};
	if (existsSync(path)) {
		try {
			stored = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			stored = {};
		}
	}
	if (!stored.token) {
		stored.token = randomBytes(16).toString("hex");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, `${JSON.stringify(stored, null, "\t")}\n`, { mode: 0o600 });
	}
	return {
		configPath: path,
		token: opts.token ?? stored.token!,
		port: opts.port ?? stored.port ?? 8787,
		// LAN by design: phones/browsers pair over the network and the pairing
		// token is the gate. Loopback-only here silently breaks every remote
		// client while localhost checks keep passing — bind 0.0.0.0 unless the
		// user pins a host.
		host: opts.host ?? stored.host ?? "0.0.0.0",
		cwd: opts.cwd ?? join(dir, "omni-home"),
	};
}

export function tokensMatch(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return ab.length === 0 || ab.equals(bb);
}
