# Dispatching worker agents (devloop bridge)

The omni can create worktrees (`omni_worktree`) and delegate to sessions
(`omni_send`) — but until now nothing **launched** a worker. If no pi session
was live in a repo, delegation stalled; if a worker died, it stayed dead.
`pppi dispatch` closes that loop, borrowing [devloop](https://github.com/magicalne/devloop)'s
`dev-start` shape (worktree + fresh agent in a tmux window) with pppi's
conventions (`.worktrees/` inside the repo, `wt/*` branches):

```
pppi dispatch <repo-path> <role-name> [tmux-window] [options]
```

## What one command does

1. **Worktree** — ensures `<repo>/.worktrees/<role>` on branch `wt/<role>`
   (reuses an existing dir; reattaches a leftover branch; prunes stale
   registrations after an `rm -rf`). Optional `--base <ref>` for fresh ones
   (default: the repo checkout's HEAD).
2. **tmux window** — opens a fresh `pi` there: window named `<role>`, in the
   tmux session given by `--session`, else the current one (when run inside
   tmux), else a session named after the repo — created detached if missing.
   The window is created with `-d`, so the human's view is never yanked away;
   `tmux attach -t <session>` and select the window to watch the worker think.
   A same-named window with no live session behind it is a stale shell — it is
   killed and respawned (that is the "dead workers stop staying dead" part).
3. **Registration** — polls the pigeon registry until the new pi appears
   (default 90s, `--timeout <s>`), then **names the session `<role>`** so
   `omni_send`, the client target drawer, and profile labels all work.
4. **Handle** — prints the session id, pid, state, and the pigeon handle
   (`--json` for machine-readable output).

## Idempotency

Dispatch is safe to re-run any time:

- a live session already named `<role>` → returned as-is (`status: reused`),
  zero side effects;
- an unnamed live session sitting in the role's worktree (a rotated worker) →
  reused and renamed;
- a live session named `<role>` but working **outside** the repo → hard error
  (the name routes messages; it must not be ambiguous).

## Options & environment

| | |
|---|---|
| `--session <name>` | tmux session for the window |
| `--base <ref>` | base ref for a fresh worktree |
| `--timeout <s>` | registration wait (default 90) |
| `--json` | machine-readable result |
| `PPPI_PI_BIN` | agent binary for the window (default `pi`) |
| `DEV_SKILLS_AGENT` | devloop's override of the same — `PPPI_PI_BIN` wins |

Workers are TUI sessions by design: the human can always attach and watch or
type alongside. "Headless" means the tmux *session* is detached (the default
when none exists) — there is no non-tmux mode; tmux is the process manager
for the worktree layer.

## From the omni agent

`omni_dispatch` wraps the same core (registered repo name or path + role):
use it when a registered repo has **no live session** to delegate to, or its
worker died (`unreach`, or silent). Cap: ~2 dispatched workers per repo unless
the user asks for more. Role names are load-bearing — worktree, branch, tmux
window, and the session name all derive from them: short, kebab-case, stable
per concern (`reconnect-resume`, not `fix-final-2`).

## Manual QA (3 commands)

```sh
# 1. dispatch a scratch worker (watch its tmux window open)
bun packages/omni/src/cli.ts ~/Workspace/opensource/pppi qa-dispatch
# → prints: worktree .worktrees/qa-dispatch (wt/qa-dispatch), tmux pppi:qa-dispatch,
#           session #xxxx pid=… (idle), handle qa-dispatch

# 2. verify it answers as a pigeon peer
pigeon status qa-dispatch        # busy/idle + last reply
pigeon send qa-dispatch "reply with: ready" && pigeon replies

# 3. re-run — must be idempotent
bun packages/omni/src/cli.ts ~/Workspace/opensource/pppi qa-dispatch
# → "worker \"qa-dispatch\" already live — reused", no new window

# teardown: tmux kill-window -t pppi:qa-dispatch && git -C <repo> worktree remove .worktrees/qa-dispatch
```

Unit tests cover argument assembly, session resolution order, idempotency
matching, stale-window respawn, and the worktree edge cases with the tmux /
pigeon / pi boundaries stubbed: `packages/omni/test/dispatch.test.ts`.
