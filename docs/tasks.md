# Requests vs tasks — the chat lane stays conversational (#15)

Two kinds of exchanges flow through pppi, and the protocol now tells them apart:

- **Request** — the user talking to the agent, expecting the fastest possible response. Always the main chat lane; never queues behind work.
- **Task** — accepted work that takes time (peer delegations, long ops, background jobs). Announced with a status, runs in the background, delivers its result asynchronously.

This is the parent abstraction of #13 (omni coordination); #29's `peer_report` notification announces delegated replies, #17 artifacts carry rich results, #22 keeps the client resilient across it all.

## How an agent runs a task

Announce/update it with a `pppi-task` fence in any reply — same mechanics as artifacts (`docs/artifacts.md`):

````markdown
On it — that's a background job now.

```pppi-task id=deploy-v12 title="Deploy v1.2 to prod" status=queued
```
````

Later (after `omni_replies` brings the outcome), update the SAME id:

```pppi-task id=deploy-v12 status=done detail="PR #31 merged — deployed"
```

- `id` (required, stable) ties updates together — cards flip in place.
- `status`: `queued` → `running` → `done` | `failed` (an unknown status degrades to a plain code block, the #28 tolerance pattern).
- `title` (defaults to the id), `detail` optional one-liner (progress or outcome).

## Rules for the agent

1. **Requests never block on tasks.** Announce the task, answer the user, done. Blocking is allowed only when the user explicitly asks to wait (#13 rule, now protocol-level).
2. One task per job; update rather than re-announce (same id).
3. The result lands in the conversation when it lands — normal markdown, or an artifact if it meets the #17 criteria (tables/dashboards/visual/long structured). `status=done` with a `detail` one-liner + the result below is the shape.
4. Tasks ride replies only — they never touch the voice lane (STT/barge-in/TTS); fences are stripped from chat text and never spoken.

## Client behavior

- A task fence renders as a **job card** at the announcing message (position preserved like artifact cards): glyph + title + status line (`○ queued` / `◐ running` / `● done` / `✕ failed`).
- `task` events (broadcast by the gateway when a task changes) update cards **in place** — the card the user watched go running flips to done without a new message. `hello_ok.tasks` seeds the registry for reconnects (#22 resume).
- The composer and chat stay fully interactive while tasks run — that's the point.

## Wire shape

`packages/protocol` (TS) and `apps/android/.../Protocol.kt` stay in sync (v8):

```ts
type TaskUpdate = { id: string; title: string; status: "queued" | "running" | "done" | "failed"; detail?: string };
// ChatEntry.tasks?: TaskUpdate[]   (entry-time snapshots)
// ServerEvent: { type: "task"; task: TaskUpdate }   (live transitions)
// hello_ok.tasks?: TaskUpdate[]    (reconnect snapshot, latest 30)
```

The gateway peels fences at every client-facing boundary (assistant finals, delegated replies, hello/history — the #17 seam), keeps a latest-per-id registry, and broadcasts changes only.
