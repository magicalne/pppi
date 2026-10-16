// Devloop-style worker dispatch (issue #1).
//
// The omni can create worktrees (worktree.ts) and talk to sessions
// (pigeon.ts) — but nothing LAUNCHES a worker. dispatch() bridges the gap:
//
//   pppi dispatch <repo> <role>
//     → .worktrees/<role> on wt/<role>        (pppi worktree convention)
//     → a fresh pi in a tmux window in it     (devloop dev-start convention)
//     → waits for pigeon registration
//     → names the session <role>              (omni_send target / client label)
//
// Idempotent: a live session already holding the role (by name, or by cwd
// inside the role's worktree) is returned as-is. A stale tmux window with no
// live session behind it is killed and respawned — dead workers stop staying
// dead.
//
// The pi/tmux/pigeon boundaries are injectable (DispatchDeps) so tests can
// drive the whole flow without spawning anything.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";
import { type PigeonSession, listSessions, pigeon } from "./pigeon.ts";
import { validateName } from "./worktree.ts";

const run = promisify(execFile);

export type ProcResult = { code: number; stdout: string; stderr: string };

export type DispatchDeps = {
	/** run git -C <repo> <args> */
	git: (repo: string, args: string[]) => Promise<ProcResult>;
	/** run tmux <args> */
	tmux: (args: string[]) => Promise<ProcResult>;
	/** live+dead registry entries (pigeon list --all --json); state "unreach" = dead */
	listSessions: () => Promise<PigeonSession[] | { error: string }>;
	/** rename a session (pigeon name, routed via PI_SESSION_ID) */
	nameSession: (sessionId: string, name: string) => Promise<ProcResult>;
	/** does this path exist (worktree-reuse check) */
	exists: (path: string) => boolean;
	sleep: (ms: number) => Promise<void>;
	/** process.env (or a test double) — TMUX / PI bin overrides */
	env: Record<string, string | undefined>;
};

export type DispatchParams = {
	/** absolute repo path */
	repo: string;
	/** worker role: worktree name, branch suffix, tmux window, session name */
	role: string;
	/** base ref for a fresh worktree (default: the repo checkout's HEAD) */
	base?: string;
	/** explicit tmux session (default: current if inside tmux, else one named after the repo) */
	session?: string;
	/** tmux window name (default: the role) */
	window?: string;
	/** how long to wait for the spawned pi to register in pigeon */
	timeoutMs?: number;
};

export type DispatchResult = {
	status: "dispatched" | "reused";
	role: string;
	repo: string;
	worktree: string;
	branch: string;
	worktreeReused: boolean;
	tmuxSession: string;
	tmuxSessionCreated: boolean;
	window: string;
	windowRespawned: boolean;
	sessionId: string;
	sessionShort: string;
	pid: number;
	state: string;
	/** the pigeon target string to omni_send to */
	handle: string;
	/** the rename actually ran (false = session already carried the name) */
	named: boolean;
	warnings: string[];
};

export class DispatchError extends Error {}

export const DEFAULT_REGISTRATION_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

/** Which agent binary a dispatched window runs. PPPI_PI_BIN (pppi) wins over
 *  DEV_SKILLS_AGENT (devloop's override) so both ecosystems can coexist. */
export function resolvePiBin(env: Record<string, string | undefined>): string {
	return env.PPPI_PI_BIN || env.DEV_SKILLS_AGENT || "pi";
}

export function worktreeDir(repo: string, role: string): string {
	return `${repo.replace(/\/$/, "")}/.worktrees/${role}`;
}

function branchFor(role: string): string {
	return `wt/${role}`;
}

function isLive(s: PigeonSession): boolean {
	return s.state !== "unreach";
}

function inDir(cwd: string, dir: string): boolean {
	const root = dir.replace(/\/$/, "");
	return cwd === root || cwd.startsWith(`${root}/`);
}

/** The live session already holding this role, if any: by name first (that is
 *  what the handle routes to), else by cwd inside the role's worktree (a
 *  rotated/unnamed session of the same worker). */
export function findLiveWorker(
	sessions: PigeonSession[],
	repo: string,
	role: string,
): { session: PigeonSession; by: "name" | "cwd" } | undefined {
	const live = sessions.filter(isLive);
	const byName = live.find((s) => (s.name ?? "").toLowerCase() === role.toLowerCase());
	if (byName) return { session: byName, by: "name" };
	const byCwd = live.find((s) => inDir(s.cwd, worktreeDir(repo, role)));
	if (byCwd) return { session: byCwd, by: "cwd" };
	return undefined;
}

/** tmux argv for the worker window. -d: never yank the human's view. */
export function windowTmuxArgs(session: string, window: string, worktree: string, bin: string): string[] {
	return ["new-window", "-d", "-t", session, "-n", window, "-c", worktree, bin];
}

/** Resolve the tmux session to open the window in:
 *  explicit > current (we run inside tmux) > existing repo-named > new detached. */
export async function resolveTmuxTarget(
	deps: DispatchDeps,
	opts: { explicit?: string; repoName: string },
): Promise<{ session: string; created: boolean }> {
	if (opts.explicit) {
		const has = await deps.tmux(["has-session", "-t", `=${opts.explicit}`]);
		if (has.code === 0) return { session: opts.explicit, created: false };
		const mk = await deps.tmux(["new-session", "-d", "-s", opts.explicit]);
		if (mk.code !== 0) throw new DispatchError(`tmux could not create session "${opts.explicit}": ${mk.stderr.trim()}`);
		return { session: opts.explicit, created: true };
	}
	if (deps.env.TMUX) {
		const cur = await deps.tmux(["display-message", "-p", "#S"]);
		if (cur.code === 0 && cur.stdout.trim()) return { session: cur.stdout.trim(), created: false };
	}
	const has = await deps.tmux(["has-session", "-t", `=${opts.repoName}`]);
	if (has.code === 0) return { session: opts.repoName, created: false };
	const mk = await deps.tmux(["new-session", "-d", "-s", opts.repoName]);
	if (mk.code !== 0)
		throw new DispatchError(
			`tmux could not create session "${opts.repoName}" (and no tmux is running?): ${mk.stderr.trim()}`,
		);
	return { session: opts.repoName, created: true };
}

/** Create the worktree if needed. Tolerates both a leftover directory and a
 *  leftover wt/<role> branch whose worktree was removed. */
export async function ensureWorktree(
	deps: DispatchDeps,
	repo: string,
	role: string,
	base?: string,
): Promise<{ path: string; branch: string; reused: boolean }> {
	const target = worktreeDir(repo, role);
	const branch = branchFor(role);
	if (deps.exists(target)) return { path: target, branch, reused: true };
	const add = (args: string[]) => deps.git(repo, ["worktree", "add", target, ...args]);
	const baseArgs = base ? [base] : [];

	let res = await add(["-b", branch, ...baseArgs]);
	if (res.code === 0) return { path: target, branch, reused: false };
	// "a branch named 'wt/x' already exists" — attach to it instead
	if (/a branch named .* already exists/i.test(res.stderr)) {
		res = await add([branch]);
		if (res.code === 0) return { path: target, branch, reused: true };
	}
	// the dir was rm -rf'd; prune stale registrations (repo-scoped, only
	// touches missing worktrees) and try both forms again
	if (/missing but already registered/i.test(res.stderr)) {
		await deps.git(repo, ["worktree", "prune"]);
		const r2 = await add([branch]); // branch survived
		if (r2.code === 0) return { path: target, branch, reused: true };
		const r3 = await add(["-b", branch, ...baseArgs]); // branch was new
		if (r3.code === 0) return { path: target, branch, reused: true };
		res = r3;
	}
	throw new DispatchError(`git worktree add failed: ${res.stderr.trim()}`);
}

async function listWindows(deps: DispatchDeps, session: string): Promise<string[]> {
	const res = await deps.tmux(["list-windows", "-t", session, "-F", "#{window_name}"]);
	if (res.code !== 0) return [];
	return res.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/** Poll the registry until a NEW live session appears inside the worktree. */
export async function waitForRegistration(
	deps: DispatchDeps,
	worktree: string,
	baselineIds: Set<string>,
	timeoutMs: number,
): Promise<PigeonSession> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const sessions = await deps.listSessions();
		if (!Array.isArray(sessions)) throw new DispatchError(`pigeon list failed: ${sessions.error}`);
		const candidates = sessions.filter((s) => isLive(s) && !baselineIds.has(s.sessionId) && inDir(s.cwd, worktree));
		// several sessions in one worktree should not happen; prefer the
		// unnamed (fresh pi has no name yet), then the newest
		candidates.sort((a, b) => {
			const an = a.name ? 1 : 0;
			const bn = b.name ? 1 : 0;
			if (an !== bn) return an - bn;
			return b.startedAt - a.startedAt;
		});
		const found = candidates[0];
		if (found) return found;
		if (Date.now() >= deadline) {
			throw new DispatchError(
				`no pi session registered in ${worktree} within ${Math.round(timeoutMs / 1000)}s — inspect the window with: tmux capture-pane -t '<session>:<window>' -p`,
			);
		}
		await deps.sleep(POLL_INTERVAL_MS);
	}
}

export async function dispatch(deps: DispatchDeps, params: DispatchParams): Promise<DispatchResult> {
	const { repo, role } = params;
	const invalid = validateName(role);
	if (invalid) throw new DispatchError(invalid);

	const warnings: string[] = [];

	// ---- idempotency: is a live worker already holding this role?
	const before = await deps.listSessions();
	if (!Array.isArray(before)) throw new DispatchError(`pigeon list failed: ${before.error}`);
	const existing = findLiveWorker(before, repo, role);
	if (existing) {
		const s = existing.session;
		if (existing.by === "name" && !inDir(s.cwd, repo)) {
			throw new DispatchError(
				`a live session named "${role}" already exists outside ${repo} (cwd=${s.cwd}) — pick another role name or rename that session`,
			);
		}
		let named = false;
		if ((s.name ?? "").toLowerCase() !== role.toLowerCase()) {
			const res = await deps.nameSession(s.sessionId, role);
			if (res.code !== 0)
				warnings.push(`rename failed (${res.stderr.trim()}) — target it as #${s.sessionId.slice(0, 4)}`);
			else named = true;
		}
		return {
			status: "reused",
			role,
			repo,
			worktree: worktreeDir(repo, role),
			branch: branchFor(role),
			worktreeReused: true,
			tmuxSession: "",
			tmuxSessionCreated: false,
			window: params.window ?? role,
			windowRespawned: false,
			sessionId: s.sessionId,
			sessionShort: `#${s.sessionId.slice(0, 4)}`,
			pid: s.pid,
			state: s.state ?? "?",
			handle: role,
			named,
			warnings,
		};
	}
	const baselineIds = new Set(before.map((s) => s.sessionId));

	// ---- worktree
	const wt = await ensureWorktree(deps, repo, role, params.base);

	// ---- tmux window
	const bin = resolvePiBin(deps.env);
	const target = await resolveTmuxTarget(deps, { explicit: params.session, repoName: basename(repo) });
	const window = params.window ?? role;
	const windows = await listWindows(deps, target.session);
	let windowRespawned = false;
	if (windows.includes(window)) {
		// no live worker holds the role, so a same-named window is a stale
		// shell (its pi died or never finished registering) — replace it
		const kill = await deps.tmux(["kill-window", "-t", `${target.session}:${window}`]);
		if (kill.code !== 0) throw new DispatchError(`tmux kill-window failed: ${kill.stderr.trim()}`);
		windowRespawned = true;
	}
	const spawn = await deps.tmux(windowTmuxArgs(target.session, window, wt.path, bin));
	if (spawn.code !== 0) {
		throw new DispatchError(`tmux new-window failed: ${spawn.stderr.trim()} (binary: ${bin})`);
	}

	// ---- registration + naming
	const session = await waitForRegistration(
		deps,
		wt.path,
		baselineIds,
		params.timeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS,
	);
	let named = false;
	if ((session.name ?? "").toLowerCase() !== role.toLowerCase()) {
		const res = await deps.nameSession(session.sessionId, role);
		if (res.code !== 0) {
			warnings.push(`rename failed (${res.stderr.trim()}) — target it as #${session.sessionId.slice(0, 4)}`);
		} else {
			named = true;
		}
	}

	return {
		status: "dispatched",
		role,
		repo,
		worktree: wt.path,
		branch: wt.branch,
		worktreeReused: wt.reused,
		tmuxSession: target.session,
		tmuxSessionCreated: target.created,
		window,
		windowRespawned,
		sessionId: session.sessionId,
		sessionShort: `#${session.sessionId.slice(0, 4)}`,
		pid: session.pid,
		state: session.state ?? "?",
		handle: named ? role : `#${session.sessionId.slice(0, 4)}`,
		named,
		warnings,
	};
}

/** Real-process deps: git + tmux + the pigeon CLI. */
export function realDeps(): DispatchDeps {
	const proc = async (cmd: string, args: string[]): Promise<ProcResult> => {
		try {
			const { stdout } = await run(cmd, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
			return { code: 0, stdout, stderr: "" };
		} catch (err) {
			const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
			return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(err) };
		}
	};
	return {
		git: (repo, args) => proc("git", ["-C", repo, ...args]),
		tmux: (args) => proc("tmux", args),
		listSessions,
		nameSession: (sessionId, name) => pigeon(["name", name], { sessionId, timeoutMs: 15_000 }),
		exists: (path) => existsSync(path),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		env: process.env,
	};
}

export function formatDispatchResult(r: DispatchResult): string {
	const lines =
		r.status === "reused"
			? [`worker "${r.role}" already live — reused`]
			: [
					`dispatched worker "${r.role}"`,
					r.tmuxSessionCreated
						? `  tmux:    new detached session "${r.tmuxSession}"`
						: `  tmux:    ${r.tmuxSession}:${r.window}`,
					r.windowRespawned ? "  window:  respawned (stale window replaced)" : null,
				];
	lines.push(
		`  repo:    ${r.repo}`,
		`  worktree:${r.worktree} (${r.branch}${r.worktreeReused ? ", reused" : ""})`,
		`  session: ${r.sessionShort} pid=${r.pid} (${r.state})`,
		`  handle:  ${r.handle}`,
	);
	for (const w of r.warnings) lines.push(`  ! ${w}`);
	return lines.filter(Boolean).join("\n");
}
