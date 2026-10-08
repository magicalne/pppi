// The pppi omni tool surface as a pi-durable extension — the port of
// packages/omni/src/extension.ts for the durable omni driver
// (docs/plan/durable-omni-pilot.md). The logic modules are reused as-is;
// only the registration shape changes (defineTool/section instead of
// pi.registerTool/before_agent_start). Repo sessions stay ordinary pi
// processes — this extension shells out to the same pigeon CLI.

import { type ToolExecutionResult, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { OMNI_SYSTEM_PROMPT, describeSessions } from "@pppi/omni";
import { type PigeonSession, listSessions, pigeon, sessionsForRepo } from "@pppi/omni/pigeon";
import { type RepoRegistry, addRepo, displayPath, findRepo, loadRegistry, removeRepo } from "@pppi/omni/repos";
import { addWorktree, listWorktrees, parseWorktrees, removeWorktree } from "@pppi/omni/worktree";
import { Type } from "typebox";
import { listExplicitProfiles } from "../profiles.ts";

/** Stable pigeon identity for the durable omni (marks `me` in session listings). */
export const DURABLE_OMNI_SESSION = "pppi-omni-durable";

function text(t: string): ToolExecutionResult<Record<string, never>> {
	return { content: [{ type: "text", text: t }] };
}

const omniRepos = defineTool({
	name: "omni_repos",
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
	async execute(args) {
		const reg = loadRegistry();
		if (args.action === "list") {
			if (reg.repos.length === 0) return text("no repos registered yet — add one with omni_repos action=add");
			const sessions = await listSessions();
			const lines = reg.repos.map((r) => {
				const inRepo = Array.isArray(sessions) ? sessionsForRepo(sessions, r.path) : [];
				const live = Array.isArray(sessions)
					? inRepo.map((s) => `#${s.sessionId.slice(0, 4)} ${s.name ?? "unnamed"} (${s.state})`).join(", ")
					: "";
				return `- ${r.name}  ${displayPath(r.path)}${live ? `\n    sessions: ${live}` : "\n    (no open sessions)"}`;
			});
			if (!Array.isArray(sessions)) lines.push(`(could not list sessions: ${sessions.error})`);
			return text(lines.join("\n"));
		}
		if (args.action === "add") {
			if (!args.path) return text("add needs a repository path");
			const res = addRepo(reg, args.path, args.name);
			return text(
				res.ok ? `registered repo "${res.repo.name}" at ${displayPath(res.repo.path)}` : `error: ${res.error}`,
			);
		}
		if (!args.name && !args.path) return text("remove needs a repo name or path");
		const res = removeRepo(reg, args.name ?? args.path!);
		return text(res.ok ? `removed repo "${res.repo.name}"` : `error: ${res.error}`);
	},
});

const omniSessions = defineTool({
	name: "omni_sessions",
	description:
		"List all open pi sessions known to pigeon, tagged with the registered repo they are working in. " +
		"Use this to see who is busy, idle, or missing before delegating work.",
	parameters: Type.Object({}),
	async execute() {
		const reg = loadRegistry();
		const sessions = await listSessions();
		if (!Array.isArray(sessions)) return text(`error: ${sessions.error}`);
		return text(describeSessions(sessions as PigeonSession[], reg as RepoRegistry));
	},
});

const omniSend = defineTool({
	name: "omni_send",
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
	async execute(args) {
		const reg = loadRegistry();
		let target = args.target;
		const repo = findRepo(reg, target);
		if (repo) {
			const sessions = await listSessions();
			if (!Array.isArray(sessions)) return text(`error: ${sessions.error}`);
			const inRepo = sessionsForRepo(sessions, repo.path).filter((s) => !s.me);
			if (inRepo.length === 0)
				return text(
					`no open session is working in repo "${repo.name}" (${displayPath(repo.path)}). Start one there, or pick another target.`,
				);
			const best = inRepo.find((s) => s.cwd === repo.path) ?? inRepo[0];
			if (!best) return text(`no open session is working in repo "${repo.name}"`);
			target = best.name ?? `#${best.sessionId.slice(0, 4)}`;
		}
		const cli = ["send", target, args.message];
		if (args.wait) cli.push("--wait", "--timeout", String(args.timeout ?? 120));
		const res = await pigeon(cli, {
			sessionId: DURABLE_OMNI_SESSION,
			timeoutMs: (args.wait ? (args.timeout ?? 120) : 30) * 1000 + 5_000,
		});
		const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
		return text(out || (res.code === 0 ? "sent" : `pigeon exited ${res.code}`));
	},
});

const omniReplies = defineTool({
	name: "omni_replies",
	description:
		"Collect replies (and drop-notices) for messages you sent via omni_send. Consumes the mailbox " +
		"unless keep=true. Waits up to timeout seconds for the first entry.",
	parameters: Type.Object({
		keep: Type.Optional(Type.Boolean({ description: "Keep entries in the mailbox (default false)" })),
		timeout: Type.Optional(Type.Number({ description: "Seconds to wait for the first entry (default 5)" })),
	}),
	async execute(args) {
		const cli = ["replies", "--json", "--timeout", String(args.timeout ?? 5)];
		if (args.keep) cli.push("--keep");
		const res = await pigeon(cli, {
			sessionId: DURABLE_OMNI_SESSION,
			timeoutMs: (args.timeout ?? 5) * 1000 + 10_000,
		});
		const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
		return text(out || "(no replies yet)");
	},
});

const omniWorktree = defineTool({
	name: "omni_worktree",
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
	async execute(args) {
		const reg = loadRegistry();
		const repo = findRepo(reg, args.repo);
		if (!repo) return text(`unknown repo "${args.repo}" — register it first with omni_repos action=add`);
		if (args.action === "list") {
			const res = await listWorktrees(repo.path);
			if (!res.ok) return text(`error: ${res.error}`);
			const wts = parseWorktrees(res.output);
			return text(
				wts.map((w) => `- ${w.name}  ${w.branch ? w.branch : "(detached)"}  ${displayPath(w.path)}`).join("\n"),
			);
		}
		if (args.action === "add") {
			if (!args.name) return text("add needs a worktree name");
			const res = await addWorktree(repo.path, args.name, { base: args.base });
			return text(
				res.ok
					? `worktree "${args.name}" ready on branch ${res.branch} at ${displayPath(res.path)}`
					: `error: ${res.error}`,
			);
		}
		if (!args.name) return text("remove needs a worktree name");
		const res = await removeWorktree(repo.path, args.name);
		return text(res.ok ? `removed worktree "${args.name}"` : `error: ${res.error}`);
	},
});

const pppiProfiles = defineTool({
	name: "pppi_profiles",
	description:
		"List pppi profiles of pi sessions on this machine: name, color and description. " +
		"Read the descriptions to decide which session to delegate work to (via pigeon send).",
	parameters: Type.Object({}),
	async execute() {
		const profiles = listExplicitProfiles();
		if (profiles.length === 0) {
			return text("no profiles yet — sessions can create one with /pppi_profile");
		}
		const body = profiles.map((p) => `${p.name} (${p.color}) — ${p.description} [id: ${p.id.slice(0, 8)}…]`).join("\n");
		return text(body);
	},
});

/** The omni extension: system prompt + the hierarchy tools (pigeon CLI unchanged). */
export const omniExtension = defineExtension({
	name: "omni",
	sections: [section("omni-hierarchy", () => OMNI_SYSTEM_PROMPT, { tag: false })],
	tools: [omniRepos, omniSessions, omniSend, omniReplies, omniWorktree, pppiProfiles],
});
