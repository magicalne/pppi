// Unit tests for the /api/sessions classifier: repo claiming by path (the
// pppi-native `.worktrees/` layout), by sibling worktree `.git` pointer file,
// and the peer-name fallback to profiles.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PigeonSession } from "@pppi/omni/pigeon";
import type { Profile } from "@pppi/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifySessions, resolveWorktreePointer } from "../src/gateway.ts";

function session(overrides: Partial<PigeonSession> & { sessionId: string; cwd: string }): PigeonSession {
	return {
		v: 1,
		pid: 1,
		name: null,
		host: "box",
		startedAt: 0,
		lastSeen: 0,
		sock: "/sock",
		sessionFile: null,
		state: "idle",
		...overrides,
	};
}

const profile = (id: string, name: string): Profile => ({ id, name, color: "#123456", description: "" });

describe("resolveWorktreePointer", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pppi-classify-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("resolves a sibling worktree's .git pointer file", () => {
		const repo = join(tmp, "road");
		const wt = join(tmp, "road-80");
		mkdirSync(wt);
		writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "road-80")}\n`);
		expect(resolveWorktreePointer(wt)).toEqual({ mainPath: repo, worktree: "road-80" });
	});

	it("returns null for a plain repo (.git directory) and non-git dirs", () => {
		const plain = join(tmp, "clone");
		mkdirSync(join(plain, ".git"), { recursive: true });
		const plainDir = join(tmp, "no-git");
		mkdirSync(plainDir);
		expect(resolveWorktreePointer(plain)).toBeNull();
		expect(resolveWorktreePointer(plainDir)).toBeNull();
	});

	it("returns null for a malformed pointer", () => {
		const bogus = join(tmp, "bogus");
		mkdirSync(bogus);
		writeFileSync(join(bogus, ".git"), "not a gitdir line\n");
		expect(resolveWorktreePointer(bogus)).toBeNull();
	});
});

describe("classifySessions", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pppi-classify-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	/** Create a sibling worktree dir whose .git points at <repo>/.git/worktrees/<name>. */
	function siblingWorktree(repo: string, dirName: string, gitWorktreeName: string): string {
		const wt = join(tmp, dirName);
		mkdirSync(wt);
		writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", gitWorktreeName)}\n`);
		return wt;
	}

	it("nests .worktrees/ sessions under their repo by path (existing behavior)", () => {
		const repo = "/w/pppi";
		const main = session({ sessionId: "s-main", cwd: repo });
		const wt = session({ sessionId: "s-wt", cwd: `${repo}/.worktrees/feat-a` });
		const { projects, others } = classifySessions([main, wt], [{ name: "pppi", path: repo }]);
		expect(projects).toHaveLength(1);
		expect(projects[0]!.sessions).toHaveLength(2);
		const byId = new Map(projects[0]!.sessions.map((s) => [s.sessionId, s]));
		expect(byId.get("s-main")).toMatchObject({ branch: "main", worktree: null });
		expect(byId.get("s-wt")).toMatchObject({ branch: "worktree", worktree: "feat-a" });
		expect(others).toEqual([]);
	});

	it("nests sibling worktrees under the repo their .git pointer names", () => {
		const repo = join(tmp, "road");
		const wtDir = siblingWorktree(repo, "road-80", "road-80");
		const s = session({ sessionId: "s-sib", cwd: wtDir });
		const { projects, others } = classifySessions([s], [{ name: "road", path: repo }]);
		expect(projects[0]!.sessions).toHaveLength(1);
		expect(projects[0]!.sessions[0]).toMatchObject({ branch: "worktree", worktree: "road-80", cwd: wtDir });
		expect(others).toEqual([]);
	});

	it("prefers the cwd basename over the gitdir worktree name", () => {
		const repo = join(tmp, "road");
		const wtDir = siblingWorktree(repo, "road-nightly", "nightly-build");
		const s = session({ sessionId: "s-nightly", cwd: wtDir });
		const { projects } = classifySessions([s], [{ name: "road", path: repo }]);
		expect(projects[0]!.sessions[0]!.worktree).toBe("road-nightly");
	});

	it("leaves non-git dirs and unregistered repos' worktrees in others as main", () => {
		const plainDir = join(tmp, "plain");
		mkdirSync(plainDir);
		const clone = join(tmp, "clone");
		mkdirSync(join(clone, ".git"), { recursive: true }); // plain repo, not a worktree
		const foreign = siblingWorktree(join(tmp, "elsewhere"), "foreign-wt", "foreign-wt"); // main repo not registered
		const { projects, others } = classifySessions(
			[
				session({ sessionId: "s-plain", cwd: plainDir }),
				session({ sessionId: "s-clone", cwd: clone }),
				session({ sessionId: "s-foreign", cwd: foreign }),
			],
			[{ name: "road", path: join(tmp, "road") }],
		);
		expect(projects[0]!.sessions).toEqual([]);
		expect(others.map((s) => s.sessionId).sort()).toEqual(["s-clone", "s-foreign", "s-plain"]);
		for (const s of others) expect(s).toMatchObject({ branch: "main", worktree: null });
	});

	it("falls back to the profile name when the pigeon name is null", () => {
		const unnamed = session({ sessionId: "s-no-name", cwd: join(tmp, "plain") });
		const named = session({ sessionId: "s-named", name: "pigeon-name", cwd: join(tmp, "plain2") });
		const { others } = classifySessions([unnamed, named], [], {
			profiles: { "s-no-name": profile("s-no-name", "night-shift") },
		});
		const byId = new Map(others.map((s) => [s.sessionId, s]));
		expect(byId.get("s-no-name")!.name).toBe("night-shift");
		expect(byId.get("s-named")!.name).toBe("pigeon-name"); // pigeon name wins
	});
});
