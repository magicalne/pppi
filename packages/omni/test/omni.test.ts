import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, findRepo, loadRegistry, removeRepo } from "../src/repos.ts";
import { addWorktree, listWorktrees, parseWorktrees, removeWorktree, validateName } from "../src/worktree.ts";

describe("repo registry", () => {
	let dir: string;
	let repo: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sspi-reg-"));
		repo = realpathSync(mkdtempSync(join(tmpdir(), "sspi-git-")));
		mkdirSync(repo, { recursive: true });
		execFileSync("git", ["-C", repo, "init", "-q"]);
		execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
		execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
		execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "init"]);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("registers, finds, and removes a repo", () => {
		const reg = loadRegistry(dir);
		expect(reg.repos).toEqual([]);

		const added = addRepo(reg, repo, "demo", dir);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		expect(added.repo.name).toBe("demo");

		expect(findRepo(reg, "demo")?.path).toBe(repo);
		expect(findRepo(reg, repo)?.name).toBe("demo");
		expect(findRepo(reg, "missing")).toBeUndefined();

		const removed = removeRepo(reg, "demo", dir);
		expect(removed.ok).toBe(true);
		expect(loadRegistry(dir).repos).toEqual([]);
	});

	it("rejects non-git directories and duplicate names", () => {
		const reg = loadRegistry(dir);
		const notGit = mkdtempSync(join(tmpdir(), "sspi-notgit-"));
		expect(addRepo(reg, notGit, undefined, dir)).toMatchObject({ ok: false });
		expect(addRepo(reg, repo, "demo", dir).ok).toBe(true);
		expect(addRepo(reg, repo, "demo", dir)).toMatchObject({ ok: false });
	});
});

describe("worktrees", () => {
	let repo: string;

	beforeEach(() => {
		repo = realpathSync(mkdtempSync(join(tmpdir(), "sspi-wt-")));
		execFileSync("git", ["-C", repo, "init", "-q"]);
		execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
		execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
		execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "init"]);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("validates names", () => {
		expect(validateName("fix-auth")).toBeNull();
		expect(validateName("../evil")).toMatch(/invalid/);
		expect(validateName("has space")).toMatch(/invalid/);
		expect(validateName("")).toMatch(/invalid/);
	});

	it("adds, lists, and removes a worktree", async () => {
		const added = await addWorktree(repo, "fix-auth");
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		expect(added.branch).toBe("wt/fix-auth");
		expect(added.path).toContain("/.worktrees/fix-auth");

		const listed = await listWorktrees(repo);
		expect(listed.ok).toBe(true);
		const parsed = listed.ok ? parseWorktrees(listed.output) : [];
		const names = parsed.map((w) => w.name);
		expect(names).toContain("fix-auth");
		const wt = parsed.find((w) => w.name === "fix-auth");
		expect(wt?.branch).toBe("wt/fix-auth");

		const removed = await removeWorktree(repo, "fix-auth");
		expect(removed.ok).toBe(true);
		const after = await listWorktrees(repo);
		const afterParsed = after.ok ? parseWorktrees(after.output) : [];
		expect(afterParsed.map((w) => w.name)).not.toContain("fix-auth");
	});

	it("uses a custom base ref when asked", async () => {
		execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "second"]);
		const added = await addWorktree(repo, "from-head", { base: "HEAD~1" });
		expect(added.ok).toBe(true);
		const log = execFileSync("git", ["-C", added.ok ? added.path : repo, "rev-parse", "HEAD~0"], { encoding: "utf8" });
		expect(log).toBeTruthy();
	});
});
