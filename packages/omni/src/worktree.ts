// Git worktree management.
// Layer 2 of the sspi hierarchy: repo session (main branch) -> worktree branches.
// Worktrees live under <repo>/.worktrees/<name> on branches wt/<name>.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type WorktreeInfo = {
	name: string;
	path: string;
	branch: string | null;
	head: string;
	bare: boolean;
	detached: boolean;
};

export type WorktreeOutcome = { ok: true; output: string } | { ok: false; error: string };

export const WORKTREE_DIR = ".worktrees";

function branchFor(name: string): string {
	return `wt/${name}`;
}

function worktreePath(repo: string, name: string): string {
	return `${repo.replace(/\/$/, "")}/${WORKTREE_DIR}/${name}`;
}

async function git(repo: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer: 16 * 1024 * 1024 });
		return { code: 0, stdout, stderr: "" };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(err) };
	}
}

export function validateName(name: string): string | null {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
		return `invalid worktree name "${name}": use letters, digits, dot, dash, underscore`;
	}
	if (name === "." || name === "..") return `invalid worktree name "${name}"`;
	return null;
}

export async function listWorktrees(repo: string): Promise<WorktreeOutcome> {
	const res = await git(repo, ["worktree", "list", "--porcelain"]);
	if (res.code !== 0) return { ok: false, error: res.stderr.trim() };
	return { ok: true, output: res.stdout };
}

export function parseWorktrees(porcelain: string): WorktreeInfo[] {
	const out: WorktreeInfo[] = [];
	let cur: Partial<WorktreeInfo> = {};
	const flush = () => {
		if (cur.path) {
			out.push({
				name: cur.path.split("/").pop() ?? cur.path,
				path: cur.path,
				branch: cur.branch ?? null,
				head: cur.head ?? "",
				bare: cur.bare === true,
				detached: cur.detached === true,
			});
		}
		cur = {};
	};
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			cur.path = line.slice("worktree ".length);
		} else if (line.startsWith("HEAD ")) {
			cur.head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		} else if (line === "bare") {
			cur.bare = true;
		} else if (line === "detached") {
			cur.detached = true;
		}
	}
	flush();
	return out;
}

export type AddWorktreeResult = { ok: true; path: string; branch: string } | { ok: false; error: string };

export async function addWorktree(
	repo: string,
	name: string,
	opts: { base?: string; branch?: string } = {},
): Promise<AddWorktreeResult> {
	const invalid = validateName(name);
	if (invalid) return { ok: false, error: invalid };
	const branch = opts.branch ?? branchFor(name);
	const target = worktreePath(repo, name);
	const base = opts.base ?? ""; // empty = current HEAD of the repo checkout
	const args = ["worktree", "add", target, "-b", branch];
	if (base) args.push(base);
	const res = await git(repo, args);
	if (res.code !== 0) return { ok: false, error: res.stderr.trim() };
	return { ok: true, path: target, branch };
}

export async function removeWorktree(repo: string, name: string): Promise<WorktreeOutcome> {
	const invalid = validateName(name);
	if (invalid) return { ok: false, error: invalid };
	const target = worktreePath(repo, name);
	const res = await git(repo, ["worktree", "remove", target]);
	if (res.code !== 0) return { ok: false, error: res.stderr.trim() };
	return { ok: true, output: res.stdout };
}

export async function defaultBranch(repo: string): Promise<string | null> {
	const res = await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	if (res.code === 0 && res.stdout.trim()) return res.stdout.trim().replace(/^origin\//, "");
	const local = await git(repo, ["symbolic-ref", "HEAD", "--short"]);
	return local.code === 0 ? local.stdout.trim() : null;
}
