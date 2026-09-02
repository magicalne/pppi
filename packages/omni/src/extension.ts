// sspi omni extension for pi.
//
// Registers the tools the omni agent uses to manage the sspi hierarchy:
//
//   omni pi session ──► repo sessions (main branch) ──► worktree branches
//
// Repo sessions are ordinary pi sessions discovered through pigeon
// (github.com/magicalne/pigeon); worktrees are git worktrees under
// <repo>/.worktrees/<name> on branches wt/<name>.
//
// Load with: pi -e <this file>  (or via extensions/omni.ts)

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listSessions, pigeon, sessionsForRepo, type PigeonSession } from "./pigeon.ts";
import { addRepo, displayPath, findRepo, loadRegistry, removeRepo, type RepoRegistry } from "./repos.ts";
import { addWorktree, listWorktrees, parseWorktrees, removeWorktree } from "./worktree.ts";

const OMNI_SYSTEM_PROMPT = `## sspi — the omni agent

You are the omni agent of sspi ("**pi"): a pointer-pointer to pi. You do not do repo work
yourself; you coordinate pi sessions that do. You manage a two-level hierarchy:

1. omni (you) -> repo sessions: one pi session per registered repository, working on its
   main branch. You discover open sessions with the omni_sessions tool (they register in
   pigeon) and delegate work with omni_send. Collect answers with omni_replies.
2. repo session (main) -> worktree branches: parallel work happens in git worktrees under
   <repo>/.worktrees/<name> on branches wt/<name> (omni_worktree tool). A repo session
   works a worktree like any directory.

Rules of conduct:
- Register repos you are asked to manage with omni_repos (add) before delegating to them.
- When you delegate, say WHY and WHAT done looks like; one concern per message.
- Always collect replies (omni_replies) before answering the user about delegated work.
- Never run long builds/tests yourself that a repo session could run in its own checkout.
- You may be talking to the user through a phone or the web: keep replies short and free
  of terminal noise. Never reveal API keys, tokens, or env secrets in replies.
- When the user's intent is ambiguous, inspect state first (omni_sessions, omni_repos,
  omni_worktree list) instead of asking immediately.`;

type ToolResponse = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function text(t: string): ToolResponse {
	return { content: [{ type: "text", text: t }], details: {} };
}

function selfSessionId(ctx: ExtensionContext): string | undefined {
	const env = process.env.PI_SESSION_ID;
	if (env) return env;
	const file = ctx.sessionManager.getSessionFile();
	if (!file) return undefined;
	const base = file.split("/").pop() ?? file;
	return base.replace(/\.jsonl$/, "");
}

function describeSessions(sessions: PigeonSession[], reg: RepoRegistry): string {
	if (sessions.length === 0) return "no open pi sessions registered (pigeon registry is empty)";
	return sessions
		.map((s) => {
			const repo = reg.repos.find((r) => s.cwd === r.path || s.cwd.startsWith(`${r.path}/`));
			const repoTag = repo ? ` [repo: ${repo.name}]` : "";
			return `#${s.sessionId.slice(0, 4)}  ${s.name ?? "unnamed"}  pid=${s.pid}  ${s.state ?? "?"}${repoTag}  cwd=${displayPath(s.cwd)}`;
		})
		.join("\n");
}

export default function sspiOmniExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: `${event.systemPrompt}\n\n${OMNI_SYSTEM_PROMPT}` };
	});

	// ---------------------------------------------------------------- repos

	pi.registerTool({
		name: "omni_repos",
		label: "Omni Repos",
		description:
			"Manage the repos you (the omni agent) coordinate. action=add registers a git repository " +
			"(path required); action=remove unregisters it; action=list shows registered repos and which " +
			"open sessions are working in them.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("remove")], {
				description: "What to do",
			}),
			path: Type.Optional(Type.String({ description: "Repository path (add/remove)" })),
			name: Type.Optional(Type.String({ description: "Short repo name (optional, defaults to basename)" })),
		}),
		async execute(_toolCallId, params) {
			const reg = loadRegistry();
			if (params.action === "list") {
				if (reg.repos.length === 0) return text("no repos registered yet — add one with omni_repos action=add");
				const sessions = await listSessions();
				const lines = reg.repos.map((r) => {
					const inRepo = Array.isArray(sessions) ? sessionsForRepo(sessions, r.path) : [];
					const live = Array.isArray(sessions) ? inRepo.map((s) => `#${s.sessionId.slice(0, 4)} ${s.name ?? "unnamed"} (${s.state})`).join(", ") : "";
					return `- ${r.name}  ${displayPath(r.path)}${live ? `\n    sessions: ${live}` : "\n    (no open sessions)"}`;
				});
				if (!Array.isArray(sessions)) lines.push(`(could not list sessions: ${sessions.error})`);
				return text(lines.join("\n"));
			}
			if (params.action === "add") {
				if (!params.path) return text("add needs a repository path");
				const res = addRepo(reg, params.path, params.name);
				return text(res.ok ? `registered repo "${res.repo.name}" at ${displayPath(res.repo.path)}` : `error: ${res.error}`);
			}
			if (!params.name && !params.path) return text("remove needs a repo name or path");
			const res = removeRepo(reg, params.name ?? params.path!);
			return text(res.ok ? `removed repo "${res.repo.name}"` : `error: ${res.error}`);
		},
	});

	// ---------------------------------------------------------------- sessions

	pi.registerTool({
		name: "omni_sessions",
		label: "Omni Sessions",
		description:
			"List all open pi sessions known to pigeon, tagged with the registered repo they are working in. " +
			"Use this to see who is busy, idle, or missing before delegating work.",
		parameters: Type.Object({}),
		async execute() {
			const reg = loadRegistry();
			const sessions = await listSessions();
			if (!Array.isArray(sessions)) return text(`error: ${sessions.error}`);
			return text(describeSessions(sessions, reg));
		},
	});

	pi.registerTool({
		name: "omni_send",
		label: "Omni Send",
		description:
			"Send a task message to another pi session (async via pigeon). Target: session name, #id-prefix, " +
			"pid, or a registered repo name (resolves to the session working in that repo). Returns a msgId; " +
			"the reply lands in your mailbox — collect it with omni_replies. wait=true blocks for the reply.",
		parameters: Type.Object({
			target: Type.String({ description: "Session name, #id-prefix, pid, or registered repo name" }),
			message: Type.String({ description: "What the peer should do; state why and what done looks like" }),
			wait: Type.Optional(Type.Boolean({ description: "Block until the peer replies (default false)" })),
			timeout: Type.Optional(Type.Number({ description: "Seconds to wait when wait=true (default 120)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reg = loadRegistry();
			let target = params.target;
			const repo = findRepo(reg, target);
			if (repo) {
				const sessions = await listSessions();
				if (!Array.isArray(sessions)) return text(`error: ${sessions.error}`);
				const inRepo = sessionsForRepo(sessions, repo.path).filter((s) => !s.me);
				if (inRepo.length === 0) return text(`no open session is working in repo "${repo.name}" (${displayPath(repo.path)}). Start one there, or pick another target.`);
				const best = inRepo.find((s) => s.cwd === repo.path) ?? inRepo[0];
				if (!best) return text(`no open session is working in repo "${repo.name}"`);
				target = best.name ?? `#${best.sessionId.slice(0, 4)}`;
			}
			const args = ["send", target, params.message];
			if (params.wait) args.push("--wait", "--timeout", String(params.timeout ?? 120));
			const res = await pigeon(args, { sessionId: selfSessionId(ctx), timeoutMs: (params.wait ? (params.timeout ?? 120) : 30) * 1000 + 5_000 });
			const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
			return text(out || (res.code === 0 ? "sent" : `pigeon exited ${res.code}`));
		},
	});

	pi.registerTool({
		name: "omni_replies",
		label: "Omni Replies",
		description:
			"Collect replies (and drop-notices) for messages you sent via omni_send. Consumes the mailbox " +
			"unless keep=true. Waits up to timeout seconds for the first entry.",
		parameters: Type.Object({
			keep: Type.Optional(Type.Boolean({ description: "Keep entries in the mailbox (default false)" })),
			timeout: Type.Optional(Type.Number({ description: "Seconds to wait for the first entry (default 5)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = ["replies", "--json", "--timeout", String(params.timeout ?? 5)];
			if (params.keep) args.push("--keep");
			const res = await pigeon(args, { sessionId: selfSessionId(ctx), timeoutMs: (params.timeout ?? 5) * 1000 + 10_000 });
			const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
			return text(out || "(no replies yet)");
		},
	});

	// ---------------------------------------------------------------- worktrees

	pi.registerTool({
		name: "omni_worktree",
		label: "Omni Worktree",
		description:
			"Manage git worktrees for a registered repo: layer 2 of the hierarchy (repo main branch -> " +
			"worktree branches). action=add creates <repo>/.worktrees/<name> on branch wt/<name>; " +
			"action=list shows worktrees; action=remove removes one. A worktree is just a directory — " +
			"delegate work in it via omni_send to a session running there, or start one.",
		parameters: Type.Object({
			repo: Type.String({ description: "Registered repo name or path" }),
			action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("remove")], {
				description: "What to do",
			}),
			name: Type.Optional(Type.String({ description: "Worktree name (add/remove)" })),
			base: Type.Optional(Type.String({ description: "Base ref for add (default: current HEAD)" })),
		}),
		async execute(_toolCallId, params) {
			const reg = loadRegistry();
			const repo = findRepo(reg, params.repo);
			if (!repo) return text(`unknown repo "${params.repo}" — register it first with omni_repos action=add`);
			if (params.action === "list") {
				const res = await listWorktrees(repo.path);
				if (!res.ok) return text(`error: ${res.error}`);
				const wts = parseWorktrees(res.output);
				return text(
					wts
						.map((w) => `- ${w.name}  ${w.branch ? w.branch : "(detached)"}  ${displayPath(w.path)}`)
						.join("\n"),
				);
			}
			if (params.action === "add") {
				if (!params.name) return text("add needs a worktree name");
				const res = await addWorktree(repo.path, params.name, { base: params.base });
				return text(
					res.ok
						? `worktree "${params.name}" ready on branch ${res.branch} at ${displayPath(res.path)}`
						: `error: ${res.error}`,
				);
			}
			if (!params.name) return text("remove needs a worktree name");
			const res = await removeWorktree(repo.path, params.name);
			return text(res.ok ? `removed worktree "${params.name}"` : `error: ${res.error}`);
		},
	});

	// ---------------------------------------------------------------- command

	pi.registerCommand("omni", {
		description: "Show the sspi hierarchy (omni -> repos -> worktrees)",
		handler: async (_args, ctx: ExtensionContext) => {
			const reg = loadRegistry();
			const sessions = await listSessions();
			const lines: string[] = ["sspi hierarchy:", ""];
			lines.push("omni (you)");
			if (!Array.isArray(sessions)) {
				lines.push(`  ! could not list sessions: ${sessions.error}`);
			}
			for (const r of reg.repos) {
				const inRepo = Array.isArray(sessions) ? sessionsForRepo(sessions, r.path) : [];
				lines.push(`  ├─ ${r.name}  ${displayPath(r.path)}`);
				const wtRes = await listWorktrees(r.path);
				const wts = wtRes.ok ? parseWorktrees(wtRes.output) : [];
				for (const s of inRepo) {
					const onMain = !s.cwd.includes("/.worktrees/");
					lines.push(`  │   ├─ session #${s.sessionId.slice(0, 4)} ${s.name ?? "unnamed"} (${s.state}) ${onMain ? "[main]" : "[worktree]"}`);
				}
				for (const w of wts) {
					if (w.name === ".worktrees" || w.path === r.path) continue;
					lines.push(`  │   └─ worktree ${w.name} (${w.branch ?? "detached"})`);
				}
			}
			if (reg.repos.length === 0) lines.push("  └─ (no repos registered — omni_repos action=add)");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
