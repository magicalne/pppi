// Pure helpers for the standalone gateway CLI — extracted so tests (and the
// systemd install docs) can exercise config/omni-mark/agent-cmd resolution
// without spawning the host. The CLI (cli.ts) composes these with the
// gateway; behavior is unchanged.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pppiDir } from "@pppi/gateway";

export function parseArgs(argv: string[]): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined || !a.startsWith("--")) continue;
		const key = a.slice(2);
		if (key === "no-stt") out[key] = true;
		else out[key] = argv[++i] ?? "";
	}
	return out;
}

/**
 * `/pppi_gateway mark` (pi extension) writes omni.json marking which session
 * is the machine's omni; the standalone host spawns its omni child with that
 * session id (resuming the same conversation), falling back to "pppi-omni".
 */
export function markedOmniSession(dir: string = pppiDir()): string | null {
	const p = join(dir, "omni.json");
	if (!existsSync(p)) return null;
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as { sessionId?: string };
		return typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null;
	} catch {
		return null;
	}
}

/**
 * Absolute path to the `pi` CLI, or bare "pi" when nothing better is known.
 * Spawning a bare name relies on the caller's PATH — the systemd user
 * manager has none (issue seen live: agent exited before get_state was
 * answered, because `pi` never spawned). Prefer the pi sitting next to the
 * running bun, then ~/.bun/bin/pi; keep "pi" as the last resort for normal
 * shell environments.
 */
export function resolvePiBinary(
	env: { HOME?: string | undefined; [key: string]: string | undefined } = process.env,
	execPath: string = process.execPath,
): string {
	const candidates = [join(dirname(execPath), "pi")];
	if (env.HOME) candidates.push(join(env.HOME, ".bun", "bin", "pi"));
	for (const c of candidates) if (existsSync(c)) return c;
	return "pi";
}

/** The default omni child command: an rpc-mode pi running the omni
 *  extension, resuming the marked session. --agent-cmd overrides wholesale. */
export function resolveAgentCmd(
	explicit: string | undefined,
	omniSessionId: string,
	extensionPath: string,
	env: { HOME?: string | undefined; [key: string]: string | undefined } = process.env,
	execPath: string = process.execPath,
): string[] {
	return explicit
		? explicit.split(/\s+/)
		: [
				resolvePiBinary(env, execPath),
				"--mode",
				"rpc",
				"--session-id",
				omniSessionId,
				"--no-approve",
				"-e",
				extensionPath,
			];
}
