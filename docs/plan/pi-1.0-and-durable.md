# Reaction plan — pi 1.0, pi-durable, and "run fewer agents"

**Date:** 2026-10-07 · **Status:** phases 1–3.2 implemented; 3.3 parked; 3.4 designed; phase 4 decided (watch)
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

**Shipped.** `SdkAgentDriver` (`packages/gateway/src/sdk-driver.ts`) is the
third `AgentPort` implementation: it hosts the omni via pi's documented
`createAgentSession()` in-process — no child process, typed events, dispositions
via `preflightResult`. Select it on the standalone host with
`bun run dev:server -- --agent sdk`. Parity with the RPC driver is locked by a
test that runs the same scripted turn through both and compares the observable
event sequence (`packages/gateway/test/sdk-driver.test.ts`). Caveats that keep
it a spike: no process isolation, and pi's built-in codemode/MCP extensions do
not auto-load in SDK sessions (pass `createCodemodeExtension()`/
`createMcpExtension()` via a custom factory when needed).

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

1. **Streaming feedback** — **shipped** (config `streamingFeedback: true` in
   `~/.pppi/config.json`, or `PPPI_STREAMING_FEEDBACK=1`; in-process voice
   sessions only). While the user is still talking, the stable prefix of the
   utterance (parakeet's committed text, ≥32 chars) is dispatched to an idle
   agent; when the utterance endpoints, only the remainder goes out — as a
   steer into the running turn (`AgentPort.prompt(text, {deliver:"steer"})`,
   pi `streamingBehavior`). If STT rewrote the early words the whole
   corrected text is steered; if the final equals the prefix nothing more is
   sent. Barge-in cancels the stale prefix answer and the full utterance
   re-asks exactly once (`cancelPendingTurn` keeps the coalescing honest).
   `packages/gateway/src/voice.ts` (`maybeDispatchPrefix`,
   `dispatchUtterance`), `gateway.ts` (`steer` dep), tests in
   `voice.test.ts` ("streaming feedback").
2. **"Needs you" status** — **shipped** (protocol v6). New `AgentState`
   `"waiting"`: the RPC driver holds a pi extension-UI dialog open for a
   short window (`PPPI_DIALOG_HOLD_MS`, default 2s) with the state set and a
   notify, then auto-dismisses as before; `here` mode tracks
   `ui_prompt_start`/`ui_prompt_end` around the human answering at the
   terminal. Web + Android status lines say "needs you…".
3. **Show-and-tell, Android first.** The post's shipped feature: record
   screen + audio while the user talks, word-level timestamps, hand the
   artifact to the agent. Natural fit for hold-to-talk; parked until 1–2
   land (they have).
4. **Shared live artifact** — designed (below); build when a client need
   crystallizes.

### 3.4 design note — the shared live artifact

The post's DOM-recorded artifact (decisions / open questions / examples /
diffs, updated live while the user talks at it) maps onto pppi as a
**session document**: a typed, fork-aware JSON doc per conversation that
the omni writes and every client renders. Concretely:

- Shape: `{ decisions: [], openQuestions: [], diffs: [] }`, one document per
  conversation, written by the omni via a `pppi_artifact` tool (TypeBox
  schema, whole-doc writes first — no op-level API yet).
- Transport: broadcast the full artifact on change over the existing ws
  (`artifact` server event, profileId-stamped); clients render a tab/drawer.
  This is deliberately pi-durable-shaped: if phase 4 ever moves the loop
  onto `Harness`, the document becomes a `defineDoc` (history
  `"rewindable"`, fork `"asOf"`) and `watchDoc` replaces the broadcast —
  the client shape does not change.
- Voice grammar: "put that in the artifact" / "what's still open?" — the
  artifact is the shared page the post argues replaces agent sprawl: one
  conversation, one live page, no task board.

## Phase 4 — pi-durable (decision: watch → durable-omni pilot shipped)

**Update 2026-10-09:** the split was re-decided — durability lands on the **omni**
(the only agent that dies with the gateway; repo sessions are independent
processes and already survive restarts), while repo sessions keep the full
pi ecosystem. Shipped as `--agent durable` (fourth `AgentPort`,
`packages/gateway/src/durable/`, plan: `durable-omni-pilot.md`): in-process
pi-durable harness, SQLite storage, omni tools ported, restart-resume locked by
test. MCP/codemode/skills remain unported (documented loss); the default rpc
child is unchanged. Posture (b) (durable repo sessions) stays shelved.

Original decision below.

## Phase 4 — pi-durable (decision: watch)

Decision on 2026-10-08, per the plan's recommendation (a): **watch**. pi-durable
re-implements the agent loop as durable tasks over pi-ai — it cannot wrap our
pi children — and its README carries "Experimental. The API changes without
notice between releases". pppi's persistence needs are met today (pi session
files, `--session-id` resume, paged history).

Revisit triggers (the pilot in posture (b) becomes attractive when any of
these is true):
- pi-durable ships a stable-API release (or we need restart-surviving
  background repo sessions badly enough to eat churn);
- delegated repo sessions must survive gateway/Mac restarts mid-task — the
  pilot shape is `Harness.open(openNodeSqliteStorage(...))` per repo session,
  `/tools` CodingTools, clients reattach via `watch()` op-frames;
- we build §3.4's artifact and want it rewindable/forkable for free.

The phase 2 SDK spike de-risks part of (b) regardless: `AgentPort` now has an
in-process implementation, so swapping the *loop* behind that seam no longer
touches the wire or clients.

Postures considered:

- **(a) Watch — chosen.** Experimental API (unstable between
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
