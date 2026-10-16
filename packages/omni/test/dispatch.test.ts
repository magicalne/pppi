// dispatch tests — argument assembly + idempotency with the tmux/pigeon/pi
// boundaries stubbed (DispatchDeps). Real end-to-end QA: docs/dispatch.md.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_REGISTRATION_TIMEOUT_MS,
	type DispatchDeps,
	type ProcResult,
	dispatch,
	ensureWorktree,
	findLiveWorker,
	resolvePiBin,
	resolveTmuxTarget,
	windowTmuxArgs,
} from "../src/dispatch.ts";
import type { PigeonSession } from "../src/pigeon.ts";

const ok = (stdout = ""): ProcResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = ""): ProcResult => ({ code: 1, stdout: "", stderr });

function session(partial: Partial<PigeonSession> & { sessionId: string; cwd: string }): PigeonSession {
	return {
		v: 2,
		pid: 4321,
		name: null,
		host: "here",
		startedAt: 1,
		lastSeen: 2,
		sock: "/sock",
		sessionFile: null,
		state: "idle",
		...partial,
	};
}

type Recorder = {
	git: string[][];
	tmux: string[][];
	names: Array<{ sessionId: string; name: string }>;
	sessionsQueue: Array<PigeonSession[] | { error: string }>;
	existsPaths: Set<string>;
	slept: number;
};

function fakeDeps(over: Partial<Recorder> & { env?: Record<string, string | undefined> } = {}) {
	const rec: Recorder = {
		git: [],
		tmux: [],
		names: [],
		sessionsQueue: over.sessionsQueue ?? [[]],
		existsPaths: over.existsPaths ?? new Set<string>(),
		slept: 0,
	};
	const deps: DispatchDeps = {
		git: async (_repo, args) => {
			rec.git.push(args);
			return ok();
		},
		tmux: async (args) => {
			rec.tmux.push(args);
			// default world: no tmux session exists yet, everything else succeeds
			return args[0] === "has-session" ? fail("no such session") : ok();
		},
		listSessions: async () => rec.sessionsQueue.shift() ?? [],
		nameSession: async (sessionId, name) => {
			rec.names.push({ sessionId, name });
			return ok();
		},
		exists: (p) => rec.existsPaths.has(p),
		sleep: async () => {
			rec.slept++;
		},
		env: over.env ?? {},
	};
	return { deps, rec };
}

const REPO = "/repos/pppi";

describe("argument assembly", () => {
	it("resolves the pi binary: PPPI_PI_BIN > DEV_SKILLS_AGENT > pi", () => {
		expect(resolvePiBin({})).toBe("pi");
		expect(resolvePiBin({ DEV_SKILLS_AGENT: "omp" })).toBe("omp");
		expect(resolvePiBin({ DEV_SKILLS_AGENT: "omp", PPPI_PI_BIN: "/custom/pi" })).toBe("/custom/pi");
	});

	it("builds the tmux window argv (detached, never steals the view)", () => {
		expect(windowTmuxArgs("pppi", "reconnect", "/repos/pppi/.worktrees/reconnect", "pi")).toEqual([
			"new-window",
			"-d",
			"-t",
			"pppi",
			"-n",
			"reconnect",
			"-c",
			"/repos/pppi/.worktrees/reconnect",
			"pi",
		]);
	});

	it("resolves the tmux target: explicit > inside-tmux > repo-named > create", async () => {
		// explicit, exists
		{
			const { deps } = fakeDeps();
			deps.tmux = async (args) => (args[0] === "has-session" ? ok() : fail());
			const r = await resolveTmuxTarget(deps, { explicit: "work", repoName: "pppi" });
			expect(r).toEqual({ session: "work", created: false });
		}
		// explicit, missing -> created
		{
			const { deps, rec } = fakeDeps();
			const r = await resolveTmuxTarget(deps, { explicit: "work", repoName: "pppi" });
			expect(r).toEqual({ session: "work", created: true });
			expect(rec.tmux).toContainEqual(["new-session", "-d", "-s", "work"]);
		}
		// inside tmux -> current session
		{
			const { deps } = fakeDeps({ env: { TMUX: "/tmp/tmux-0/default,1,0" } });
			deps.tmux = async (args) => (args[0] === "display-message" ? ok("my-session\n") : fail());
			const r = await resolveTmuxTarget(deps, { repoName: "pppi" });
			expect(r).toEqual({ session: "my-session", created: false });
		}
		// outside tmux, repo session exists
		{
			const { deps } = fakeDeps();
			deps.tmux = async (args) => (args[0] === "has-session" ? ok() : fail());
			const r = await resolveTmuxTarget(deps, { repoName: "pppi" });
			expect(r).toEqual({ session: "pppi", created: false });
		}
		// outside tmux, nothing exists -> detached repo session
		{
			const { deps, rec } = fakeDeps();
			const r = await resolveTmuxTarget(deps, { repoName: "pppi" });
			expect(r).toEqual({ session: "pppi", created: true });
			expect(rec.tmux).toContainEqual(["new-session", "-d", "-s", "pppi"]);
		}
	});
});

describe("findLiveWorker (idempotency match)", () => {
	it("matches by name, then by cwd inside the role worktree; skips dead sessions", () => {
		const dead = session({ sessionId: "dead0000", cwd: `${REPO}/.worktrees/role-a`, state: "unreach" });
		const named = session({ sessionId: "aaaa1111", cwd: "/elsewhere", name: "role-a" });
		const inWorktree = session({ sessionId: "bbbb2222", cwd: `${REPO}/.worktrees/role-b/sub` });
		expect(findLiveWorker([dead], REPO, "role-a")).toBeUndefined();
		expect(findLiveWorker([named], REPO, "role-a")).toEqual({ session: named, by: "name" });
		expect(findLiveWorker([inWorktree], REPO, "role-b")).toEqual({ session: inWorktree, by: "cwd" });
		expect(findLiveWorker([inWorktree], REPO, "role-c")).toBeUndefined();
	});
});

describe("dispatch()", () => {
	it("reuses a live session already named for the role — no git/tmux side effects", async () => {
		const worker = session({ sessionId: "cccc3333", cwd: `${REPO}/.worktrees/role-a`, name: "role-a" });
		const { deps, rec } = fakeDeps({ sessionsQueue: [[worker]] });
		const r = await dispatch(deps, { repo: REPO, role: "role-a" });
		expect(r.status).toBe("reused");
		expect(r.sessionId).toBe("cccc3333");
		expect(r.handle).toBe("role-a");
		expect(r.named).toBe(false);
		expect(rec.git).toHaveLength(0);
		expect(rec.tmux).toHaveLength(0);
		expect(rec.names).toHaveLength(0);
	});

	it("reuses an unnamed live session in the worktree and names it", async () => {
		const worker = session({ sessionId: "dddd4444", cwd: `${REPO}/.worktrees/role-a` });
		const { deps, rec } = fakeDeps({ sessionsQueue: [[worker]] });
		const r = await dispatch(deps, { repo: REPO, role: "role-a" });
		expect(r.status).toBe("reused");
		expect(rec.names).toEqual([{ sessionId: "dddd4444", name: "role-a" }]);
		expect(r.named).toBe(true);
	});

	it("refuses a same-named session living outside the repo", async () => {
		const other = session({ sessionId: "eeee5555", cwd: "/elsewhere", name: "role-a" });
		const { deps } = fakeDeps({ sessionsQueue: [[other]] });
		await expect(dispatch(deps, { repo: REPO, role: "role-a" })).rejects.toThrow(/already exists outside/);
	});

	it("dispatches: worktree, tmux window, registration wait, rename", async () => {
		const worker = session({ sessionId: "ffff6666", cwd: `${REPO}/.worktrees/role-a`, pid: 999 });
		const { deps, rec } = fakeDeps({
			sessionsQueue: [[], [], [worker]], // before, first poll, second poll
			env: { PPPI_PI_BIN: "pi" },
		});
		const r = await dispatch(deps, { repo: REPO, role: "role-a", base: "origin/main" });
		expect(r.status).toBe("dispatched");
		expect(r.worktree).toBe(`${REPO}/.worktrees/role-a`);
		expect(r.branch).toBe("wt/role-a");
		expect(rec.git).toContainEqual(["worktree", "add", `${REPO}/.worktrees/role-a`, "-b", "wt/role-a", "origin/main"]);
		expect(rec.tmux).toContainEqual(windowTmuxArgs("pppi", "role-a", `${REPO}/.worktrees/role-a`, "pi"));
		expect(rec.names).toEqual([{ sessionId: "ffff6666", name: "role-a" }]);
		expect(r.handle).toBe("role-a");
		expect(r.sessionShort).toBe("#ffff");
		expect(r.pid).toBe(999);
		expect(r.tmuxSession).toBe("pppi");
		expect(r.tmuxSessionCreated).toBe(true);
	});

	it("reuses an existing worktree dir without git worktree add", async () => {
		const worker = session({ sessionId: "a0a0a0a0", cwd: `${REPO}/.worktrees/role-a` });
		const { deps, rec } = fakeDeps({ sessionsQueue: [[], [worker]] });
		rec.existsPaths.add(`${REPO}/.worktrees/role-a`);
		const r = await dispatch(deps, { repo: REPO, role: "role-a" });
		expect(r.worktreeReused).toBe(true);
		expect(rec.git).toHaveLength(0);
	});

	it("respawns a stale window (same name, no live session behind it)", async () => {
		const worker = session({ sessionId: "b1b1b1b1", cwd: `${REPO}/.worktrees/role-a` });
		const { deps, rec } = fakeDeps({ sessionsQueue: [[], [worker]] });
		deps.tmux = async (args) => {
			rec.tmux.push(args);
			if (args[0] === "list-windows") return ok("bash\nrole-a\n"); // -F '#{window_name}' — names only
			return ok();
		};
		const r = await dispatch(deps, { repo: REPO, role: "role-a" });
		expect(r.windowRespawned).toBe(true);
		expect(rec.tmux).toContainEqual(["kill-window", "-t", "pppi:role-a"]);
	});

	it("fails loudly when no session registers in time", async () => {
		const { deps } = fakeDeps({ sessionsQueue: [[]] });
		await expect(dispatch(deps, { repo: REPO, role: "role-a", timeoutMs: 1 })).rejects.toThrow(
			/no pi session registered/,
		);
	});

	it("rejects invalid role names up front", async () => {
		const { deps } = fakeDeps();
		await expect(dispatch(deps, { repo: REPO, role: "not a name" })).rejects.toThrow(/invalid worktree name/);
	});
});

describe("ensureWorktree (real git)", () => {
	let repo: string;

	beforeEach(() => {
		repo = realpathSync(mkdtempSync(join(tmpdir(), "pppi-dispatch-")));
		execFileSync("git", ["-C", repo, "init", "-q"]);
		execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
		execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
		execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "init"]);
		mkdirSync(join(repo, ".worktrees"), { recursive: true });
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	const realGitDeps = (): DispatchDeps => {
		const run = (cmd: string, args: string[]) => {
			try {
				const stdout = execFileSync(cmd, args, { encoding: "utf8" }) as string;
				return ok(stdout);
			} catch (err) {
				const e = err as { stderr?: string };
				return fail(e.stderr ?? String(err));
			}
		};
		return {
			git: (r, args) => Promise.resolve(run("git", ["-C", r, ...args])),
			tmux: async () => ok(),
			listSessions: async () => [],
			nameSession: async () => ok(),
			exists: (p) => {
				try {
					execFileSync("test", ["-e", p]);
					return true;
				} catch {
					return false;
				}
			},
			sleep: async () => {},
			env: {},
		};
	};

	it("creates the worktree, then reuses the dir, then reattaches a leftover branch", async () => {
		const deps = realGitDeps();
		const first = await ensureWorktree(deps, repo, "w", undefined);
		expect(first.reused).toBe(false);
		expect(first.branch).toBe("wt/w");

		const second = await ensureWorktree(deps, repo, "w", undefined);
		expect(second.reused).toBe(true);

		// simulate: branch survived, worktree dir removed
		rmSync(join(repo, ".worktrees", "w"), { recursive: true, force: true });
		const third = await ensureWorktree(deps, repo, "w", undefined);
		expect(third.reused).toBe(true);
		const onBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: join(repo, ".worktrees", "w"),
			encoding: "utf8",
		}).trim();
		expect(onBranch).toBe("wt/w");
	});
});

describe("defaults", () => {
	it("waits a generous but bounded time for registration", () => {
		expect(DEFAULT_REGISTRATION_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
		expect(DEFAULT_REGISTRATION_TIMEOUT_MS).toBeLessThanOrEqual(180_000);
	});
});
