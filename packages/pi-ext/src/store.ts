// pppi paths + profile store shared by the pi extension commands.
// Keep the JSON shapes in sync with apps/server/src/profiles.ts.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PairFile = {
	machine: string;
	port: number;
	token: string;
	ips: string[];
	urls: string[];
	fingerprint: string;
};

export type Profile = {
	id: string;
	name: string;
	color: string;
	description: string;
};

export function pppiDir(): string {
	return process.env.PPPI_DIR ?? join(homedir(), ".pppi");
}

export function loadPair(): PairFile | null {
	const p = join(pppiDir(), "pair.json");
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as PairFile;
	} catch {
		return null;
	}
}

export function readProfile(sessionId: string): Profile | null {
	const p = join(pppiDir(), "profiles", `${sessionId}.json`);
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as Profile;
	} catch {
		return null;
	}
}

export function writeProfile(profile: Profile): void {
	const dir = join(pppiDir(), "profiles");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${profile.id}.json`), `${JSON.stringify(profile, null, "\t")}\n`);
}

export function listProfiles(): Profile[] {
	const dir = join(pppiDir(), "profiles");
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return JSON.parse(readFileSync(join(dir, f), "utf8")) as Profile;
				} catch {
					return null;
				}
			})
			.filter((p): p is Profile => p !== null && typeof p.name === "string");
	} catch {
		return [];
	}
}

export function writeOmniMark(mark: { sessionId: string; cwd: string; pid: number; markedAt: number }): void {
	writeFileSync(join(pppiDir(), "omni.json"), `${JSON.stringify(mark, null, "\t")}\n`);
}

export function readOmniMark(): { sessionId?: string } | null {
	try {
		return JSON.parse(readFileSync(join(pppiDir(), "omni.json"), "utf8")) as { sessionId?: string };
	} catch {
		return null;
	}
}

export function writePair(pair: PairFile): void {
	mkdirSync(pppiDir(), { recursive: true });
	writeFileSync(join(pppiDir(), "pair.json"), `${JSON.stringify(pair, null, "\t")}\n`, { mode: 0o600 });
}

/** The session id of the invoking pi session (env first, then the session file header). */
export function selfSessionId(sessionFile?: string): string | undefined {
	const env = process.env.PI_SESSION_ID;
	if (env) return env;
	if (!sessionFile) return undefined;
	try {
		const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0] ?? "{}") as { id?: string };
		if (header.id) return header.id;
	} catch {
		// fall through
	}
	const base = sessionFile.split("/").pop() ?? sessionFile;
	return (
		base
			.replace(/\.jsonl$/, "")
			.split("_")
			.pop() || undefined
	);
}
