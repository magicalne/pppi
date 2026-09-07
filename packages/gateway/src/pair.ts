// Pairing facts for this machine: what a phone or browser needs to reach the
// gateway. Written to $PPPI_DIR/pair.json so the /pair pi command can show the
// QR without the gateway running.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { PairInfo } from "@pppi/protocol";
import { pppiDir } from "./config.ts";

export function lanIps(): string[] {
	const out: string[] = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const ni of list ?? []) {
			if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
		}
	}
	return out;
}

export function buildPairInfo(cfg: { token: string; port: number }): PairInfo {
	const ips = lanIps();
	return {
		machine: process.env.PPPI_NAME ?? hostname(),
		port: cfg.port,
		token: cfg.token,
		ips,
		urls: ips.map((ip) => `http://${ip}:${cfg.port}`),
		fingerprint: createHash("sha256").update(cfg.token).digest("hex").slice(0, 8),
	};
}

export function writePairFile(pair: PairInfo): void {
	const dir = pppiDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "pair.json"), `${JSON.stringify(pair, null, "\t")}\n`, { mode: 0o600 });
}
