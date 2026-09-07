// Registry of repos the omni agent manages.
// Layer 1 of the pppi hierarchy: omni session -> repo sessions.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export type RepoEntry = {
	name: string;
	path: string;
	addedAt: number;
};

export type RepoRegistry = {
	version: 1;
	repos: RepoEntry[];
};

export function registryPath(dir?: string): string {
	return join(dir ?? process.env.PPPI_DIR ?? join(homedir(), ".pppi"), "repos.json");
}

export function loadRegistry(dir?: string): RepoRegistry {
	const p = registryPath(dir);
	if (!existsSync(p)) return { version: 1, repos: [] };
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as RepoRegistry;
		if (raw.version !== 1 || !Array.isArray(raw.repos)) return { version: 1, repos: [] };
		return raw;
	} catch {
		return { version: 1, repos: [] };
	}
}

export function saveRegistry(reg: RepoRegistry, dir?: string): void {
	const p = registryPath(dir);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, `${JSON.stringify(reg, null, "\t")}\n`);
}

export function findRepo(reg: RepoRegistry, nameOrPath: string): RepoEntry | undefined {
	const byName = reg.repos.find((r) => r.name === nameOrPath);
	if (byName) return byName;
	let real: string;
	try {
		real = realpathSync(resolve(nameOrPath.replace(/^~(?=\/|$)/, homedir())));
	} catch {
		return undefined;
	}
	return reg.repos.find((r) => r.path === real);
}

export function isGitRepo(path: string): boolean {
	const p = resolve(path.replace(/^~(?=\/|$)/, homedir()));
	if (!statSyncSafe(p)) return false;
	return existsSync(join(p, ".git")) || hasGitDirAbove(p);
}

function hasGitDirAbove(p: string): boolean {
	let cur = p;
	for (let i = 0; i < 32; i++) {
		if (existsSync(join(cur, ".git"))) return true;
		const parent = join(cur, "..");
		if (parent === cur) return false;
		cur = parent;
	}
	return false;
}

function statSyncSafe(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export type AddRepoResult = { ok: true; repo: RepoEntry } | { ok: false; error: string };

export function addRepo(reg: RepoRegistry, rawPath: string, name?: string, dir?: string): AddRepoResult {
	const p = resolve(rawPath.replace(/^~(?=\/|$)/, homedir()));
	if (!statSyncSafe(p)) return { ok: false, error: `not a directory: ${p}` };
	if (!isGitRepo(p)) return { ok: false, error: `not a git repository: ${p}` };
	let real: string;
	try {
		real = realpathSync(p);
	} catch {
		return { ok: false, error: `cannot resolve path: ${p}` };
	}
	if (reg.repos.some((r) => r.path === real)) return { ok: false, error: `already registered: ${real}` };
	const repoName = name?.trim() || basename(real);
	if (reg.repos.some((r) => r.name === repoName)) {
		return { ok: false, error: `a repo named "${repoName}" is already registered` };
	}
	const entry: RepoEntry = { name: repoName, path: real, addedAt: Date.now() };
	reg.repos.push(entry);
	saveRegistry(reg, dir);
	return { ok: true, repo: entry };
}

export function removeRepo(reg: RepoRegistry, nameOrPath: string, dir?: string): AddRepoResult {
	const found = findRepo(reg, nameOrPath);
	if (!found) return { ok: false, error: `unknown repo: ${nameOrPath}` };
	reg.repos = reg.repos.filter((r) => r !== found);
	saveRegistry(reg, dir);
	return { ok: true, repo: found };
}

/** Relative display for a path under $HOME. */
export function displayPath(p: string): string {
	const home = homedir();
	return isAbsolute(p) && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
