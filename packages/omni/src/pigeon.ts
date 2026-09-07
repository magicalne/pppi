// Thin wrapper around the `pigeon` CLI (github.com/magicalne/pigeon).
// pigeon lets independently started pi sessions discover each other, exchange
// messages, and collect replies — the transport for the pppi hierarchy.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type PigeonSession = {
	v: number;
	sessionId: string;
	pid: number;
	name: string | null;
	cwd: string;
	host: string;
	startedAt: number;
	lastSeen: number;
	sock: string;
	sessionFile: string | null;
	me?: boolean;
	state?: string;
};

export type PigeonResult = { code: number; stdout: string; stderr: string };

export function pigeonBin(): string | null {
	const candidates = [process.env.PIGEON_BIN, join(homedir(), ".local", "bin", "pigeon")];
	for (const c of candidates) {
		if (c && existsSync(c)) return c;
	}
	return null;
}

export async function pigeon(
	args: string[],
	opts: { sessionId?: string; timeoutMs?: number } = {},
): Promise<PigeonResult> {
	const bin = pigeonBin();
	if (!bin) return { code: 127, stdout: "", stderr: "pigeon CLI not found (install: github.com/magicalne/pigeon)" };
	try {
		const { stdout } = await run(bin, args, {
			timeout: opts.timeoutMs ?? 30_000,
			maxBuffer: 16 * 1024 * 1024,
			env: opts.sessionId ? { ...process.env, PI_SESSION_ID: opts.sessionId } : process.env,
		});
		return { code: 0, stdout, stderr: "" };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(err) };
	}
}

export async function listSessions(): Promise<PigeonSession[] | { error: string }> {
	const res = await pigeon(["list", "--all", "--json"]);
	if (res.code !== 0) return { error: res.stderr.trim() || "pigeon list failed" };
	try {
		return JSON.parse(res.stdout) as PigeonSession[];
	} catch {
		return { error: `pigeon list --json produced invalid output: ${res.stdout.slice(0, 200)}` };
	}
}

/** Sessions whose cwd sits inside the given directory. */
export function sessionsForRepo(sessions: PigeonSession[], repoPath: string): PigeonSession[] {
	const root = repoPath.replace(/\/$/, "");
	return sessions.filter((s) => s.cwd === root || s.cwd.startsWith(`${root}/`));
}
