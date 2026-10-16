#!/usr/bin/env bun
// pppi dispatch — spawn a worktree worker agent into a tmux window (issue #1).
//
//   pppi dispatch <repo-path> <role-name> [tmux-window] [options]
//
// Creates <repo>/.worktrees/<role> on wt/<role>, opens a fresh pi there in a
// tmux window, waits for it to register in pigeon, and names the session
// <role> so omni_send / clients can target it. Idempotent. Full story:
// docs/dispatch.md.

import { realpathSync } from "node:fs";
import { type DispatchResult, dispatch, formatDispatchResult, realDeps } from "./dispatch.ts";

const USAGE = `usage: pppi dispatch <repo-path> <role-name> [tmux-window] [options]

options:
  --session <name>   tmux session for the window (default: current when run
                     inside tmux, else a session named after the repo)
  --base <ref>       base ref for a fresh worktree (default: repo HEAD)
  --json             machine-readable result
  --timeout <s>      seconds to wait for pigeon registration (default 90)
  -h, --help         this help

environment:
  PPPI_PI_BIN        agent binary for the window (default "pi")
  DEV_SKILLS_AGENT   devloop's override of the same — PPPI_PI_BIN wins`;

function fail(msg: string, code = 2): never {
	process.stderr.write(`pppi: ${msg}\n`);
	process.exit(code);
}

type Args = {
	repo?: string;
	role?: string;
	window?: string;
	session?: string;
	base?: string;
	json: boolean;
	timeoutS?: number;
};

function parseArgs(argv: string[]): Args {
	const out: Args = { json: false };
	const pos: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "-h" || a === "--help") {
			process.stdout.write(`${USAGE}\n`);
			process.exit(0);
		}
		if (a === "--json") {
			out.json = true;
			continue;
		}
		if (a === "--session" || a === "--base" || a === "--timeout") {
			const v = argv[++i];
			if (!v) fail(`${a} needs a value`);
			if (a === "--session") out.session = v;
			else if (a === "--base") out.base = v;
			else out.timeoutS = Number(v);
			continue;
		}
		if (a.startsWith("--")) fail(`unknown option ${a}`);
		pos.push(a);
	}
	const [cmd, repo, role, window] = pos;
	if (cmd !== "dispatch") fail(`unknown command "${cmd ?? ""}" — expected: dispatch\n\n${USAGE}`);
	if (!repo || !role) fail(`expected <repo-path> <role-name> [tmux-window]\n\n${USAGE}`);
	if (pos.length > 4) fail(`too many arguments\n\n${USAGE}`);
	out.repo = repo;
	out.role = role;
	out.window = window;
	return out;
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (!args.repo || !args.role) fail("missing arguments");
	let repo: string;
	try {
		repo = realpathSync(args.repo);
	} catch {
		fail(`repo path not found: ${args.repo}`);
	}
	try {
		const result: DispatchResult = await dispatch(realDeps(), {
			repo,
			role: args.role,
			base: args.base,
			session: args.session,
			window: args.window,
			timeoutMs: args.timeoutS ? args.timeoutS * 1000 : undefined,
		});
		if (args.json) process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
		else process.stdout.write(`${formatDispatchResult(result)}\n`);
		return 0;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`pppi: dispatch failed: ${msg}\n`);
		return 1;
	}
}

main().then((code) => process.exit(code));
