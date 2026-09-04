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

export function sspiDir(): string {
	return process.env.SSPI_DIR ?? join(homedir(), ".sspi");
}

export function loadOrCreateConfig(
	opts: { port?: number; host?: string; token?: string; cwd?: string } = {},
): ServerConfig {
	const dir = sspiDir();
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
		host: opts.host ?? stored.host ?? "127.0.0.1",
		cwd: opts.cwd ?? join(dir, "omni-home"),
	};
}

export function tokensMatch(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return ab.length === 0 || ab.equals(bb);
}
