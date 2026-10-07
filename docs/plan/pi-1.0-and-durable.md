# Reaction plan — pi 1.0, pi-durable, and "run fewer agents"

**Date:** 2026-10-07 · **Status:** phase 1 implemented (this branch); phases 2–4 pending
**Inputs consumed:** pi v1.0.0 (clone at `~/Workspace/opensource/pi`, tag
`v1.0.0`; v1.0.4 is the current patch), `@earendil-works/pi-durable` +
`@earendil-works/chord` (same monorepo), and
[blog.exe.dev/etoomanythings](https://blog.exe.dev/etoomanythings) — "Run
Fewer Agents" (Josh Bleecher Snyder, exe.dev, 2026-10-01).

## Positioning

Three inputs, three different kinds of news:

1. **pi 1.0** is an upgrade of the harness pppi already rides
   (`@earendil-works/pi-coding-agent`, pinned 0.83.0). Mostly additive;
   two wire-level changes pppi must react to, several affordances pppi
   should adopt. **No architecture change required.**
2. **pi-durable** is a *new* substrate, not a wrapper: it re-implements the
   agent loop as durable tasks over pi-ai (README banner: "Experimental.
   The API changes without notice between releases"). It does **not**
   attach to a pi-coding-agent session. Adopting it means moving a
   conversation's loop onto it wholesale. **Decision point, not a TODO.**
3. **The blog post** is not a pi announcement — it's an argument that
   running many concurrent agents is latency-hiding that wrecks flow, and
   that task management is a band-aid. Its experiments (fast model for
   conversation, show-and-tell screen recording, DOM-recorded artifacts,
   streaming feedback) are design inputs. **pppi's ground rules already bet
   on this thesis** — one conversation per screen, one omni, delegation
   instead of agent sprawl. The post's ideas map onto pppi's voice stack
   almost one-to-one (see phase 3).

## Phase 1 — upgrade to pi 1.0 (small, no architecture change)

pppi survived 0.83 → 1.0 well: the RPC framing notes were already correct,
`message_update` handling is already delta-based, all extension APIs the
in-process driver uses still exist (verified in the 1.0 tree:
`sendUserMessage({deliverAs})`, `model_select`, `get/setThinkingLevel`,
`ctx.isIdle`, `sessionManager.getEntries`), every registered tool already
declares TypeBox parameters, and the RPC child spawn line
(`packages/pi-ext/src/omni-host.ts:217`) passes neither `-ne` nor
`--provider`, so the new flag strictness doesn't bite.

1. Bump `@earendil-works/pi-coding-agent` to `1.0.4` in the root
   `package.json`. Nothing else moves: the package name is unchanged,
   typebox stays `typebox`, `enabledModels` is still minimatch
   (`nocase: true`) over `provider/id` — `packages/gateway/src/gateway.ts`
   needs no change.
2. `packages/gateway/src/agent.ts` — adopt prompt dispositions: `prompt` /
   `steer` / `follow_up` responses now carry
   `data.disposition: "started" | "handled" | "queued"`; `"handled"` means
   an extension consumed the input and **no run starts** — surface that to
   clients (notify) instead of silently waiting. Tolerate
   `get_state.sessionFile` being `undefined` before the first user message
   (we don't read it — verify). The big 1.0 wire reshape (cumulative
   `message` removed from `message_update`, `partial` removed from
   `assistantMessageEvent`) costs us nothing: we only read `text_delta` +
   `delta` (`agent.ts:325-334`) and take the final text from
   `message_end.message`, which is still authoritative.
3. `packages/pi-ext/src/session-driver.ts` — behavior-compatible with 1.0
   as-is. Improvements while there: keep the `pi.on(...)` unsubscribe
   handles returned since 0.86 (the driver never detaches today), and note
   the 0.87 `agent_settled` deferral doesn't affect us (our handler only
   refreshes status).
4. **Decide: built-in extensions in the omni child.** At 1.0 the spawned
   `pi --mode rpc` child loads `builtin:mcp`, `builtin:codemode`,
   `builtin:tool-search` by default (they didn't exist at 0.83). This is a
   real capability jump for the omni (MCP servers from `~/.pi/agent/mcp.json`,
   the codemode tool) at zero code — but it changes the omni's tool surface
   and `toolLabel` coverage (`agent.ts:100`). Recommendation: keep them,
   add labels, document in README; add `--no-mcp` if a user wants it off.
5. Tests: `bun run test` + a live `/pppi_gateway` smoke on web and Android.

## Phase 2 — SDK spike (opt-in, behind a flag)

1.0 ships a documented in-process embedding story: `createAgentSession()`
(`packages/coding-agent/docs/sdk.md`) with typed `prompt()/steer()/
followUp()/abort()/waitForIdle()/subscribe()` and injectable boundaries.
That is a natural third `AgentPort` implementation (`SdkAgentDriver`)
alongside the RPC child and the extension driver:

- **Worth it:** no child process to spawn/restart/watch; typed events
  instead of JSONL; the SDK is pi's supported seam going forward.
- **Not yet a replacement:** the RPC child gives process isolation (pi
  crashes don't take the gateway) and powers `/pppi_gateway` (launcher)
  and `here` (extension driver) today. SDK sessions also skip the built-in
  codemode/MCP extensions unless explicitly re-added.

Spike only: `SdkAgentDriver` in `packages/gateway/src/`, selected by config,
parity-tested against `RpcAgentDriver`. Keep or drop based on results.

## Phase 3 — the blog post, voice-first (pppi's payoff)

Ordered by leverage:

1. **Streaming feedback** (the post's latency-hiding experiment). We
   already stream live partials (`openUtterance()` in
   `packages/gateway/src/stt.ts`); feed stable prefixes to the omni as
   they're spoken (`streamingBehavior`/steer on the RPC path, `deliverAs`
   in-process) and let it start thinking before the user finishes. Cancel
   on barge-in (we already have the machinery in `voice.ts`). This is the
   single biggest "talk to a person" win available to us.
2. **"Needs you" status.** 1.0 exposes `ui_prompt_start`/`ui_prompt_end`
   — the gateway currently auto-dismisses dialogs (`agent.ts:284-290`);
   with a new AgentState ("waiting") the status line can say so instead.
   Crosses the wire: protocol bump, `StatusBar.tsx` + `StatusBar.kt`.
3. **Show-and-tell, Android first.** The post's shipped feature: record
   screen + audio while the user talks, word-level timestamps, hand the
   artifact to the agent. Natural fit for hold-to-talk; park as an
   experiment until 1–2 land.
4. **Shared live artifact.** The post's DOM-recorded "decisions / open
   questions / diffs" artifact maps to a pppi session document rendered by
   clients — and to phase 4's documents. Design once, against durable
   docs if phase 4 happens.

## Phase 4 — pi-durable (decision point)

The honest framing first: pi-durable is the whole loop (generation/tool/
compaction as durable tasks, submissions with `whenBusy:
steer|followUp|reject`, Chord-op document watches, SQLite/JSONL storage,
crash recovery from checkpoints). It cannot wrap our pi children. Postures:

- **(a) Watch — recommended now.** Experimental API (unstable between
  releases), single-process-per-storage, no HTTP layer shipped. pppi's
  persistence needs (session files, `new_session`, `get_messages` history)
  are met today.
- **(b) Pilot: durable repo sessions.** Keep the omni on pi-coding-agent;
  stand *delegated repo sessions* on pi-durable (`Harness.open` +
  `/tools` CodingTools + `env` sandbox), so background work survives
  gateway/Mac restarts (`resume()`, task checkpoints, `requestId`
  idempotency) and clients reattach via `watch()` op-frames. Success
  criteria: a repo session survives a gateway restart mid-task and a
  client that reconnects replays in < 1s.
- **(c) Full switch of the omni.** Not now — we'd lose the coding-agent
  ecosystem (extensions, MCP/codemode, session files) for an unstable API.

Chord alone (facets, replicated state, remote service boundary) is also
available à la carte, but pppi already owns its wire protocol; don't churn
it without a concrete need.

## Sequencing

Phase 1 (one PR) → phase 3.1 streaming feedback (biggest UX win,
independent) → phase 2 spike → phase 4 decision after the spike.
Phase 3.2–3.4 queue behind protocol bandwidth.

## Open questions for review

1. Keep builtin codemode/MCP in the omni child (phase 1.4)?
2. Is the SDK spike (phase 2) wanted at all, or is RPC-only fine?
3. Appetite for the pi-durable pilot (phase 4b) now vs. watch?
4. Protocol bump for the "waiting" state (phase 3.2) — bundle with the
   next wire change or ship alone?
