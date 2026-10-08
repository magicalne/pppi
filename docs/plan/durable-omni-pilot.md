# Durable omni pilot — AgentPort #4 on pi-durable

**Date:** 2026-10-09 · **Status:** implemented · **Parent plan:** `pi-1.0-and-durable.md` §4 (posture (b)→(c) hybrid decided in conversation: **omni only**)

## Summary

Host the omni conversation on `@earendil-works/pi-durable` (1.1.0) **in-process** as a fourth
`AgentPort` implementation (`DurableAgentDriver`), selected by `--agent durable` on the standalone
host. The omni's turns become durable: a gateway restart mid-turn resumes and completes the turn
from its last checkpoint. The repo layer is untouched — repo sessions stay ordinary pi processes
discovered and driven via pigeon, exactly as today. MCP, codemode, and skills are **not** ported
(accepted pilot loss; documented).

## Context

- The omni is the only pppi agent that dies with the gateway: it is the spawned
  `pi --mode rpc` child (`omni-host.ts`). Repo sessions are independent processes and already
  survive gateway restarts.
- The pi-1.0 plan's phase 4 chose "watch" for pi-durable, with posture (b) (durable repo
  sessions) as the pilot shape. Conversation 2026-10-09 re-decided the split: durability lands on
  the omni (where the fragility is), the full pi ecosystem stays on repo sessions (where it is
  needed).
- Feasibility was **empirically validated before this plan** (bun 1.4.2, this machine):
  - Full turn over `Harness` + `MemoryStorage` + scripted fake provider: submit→wait→transcript,
    `watchEvents` emits coding-agent-style events. ✓
  - `node:sqlite` (`DatabaseSync`) works on bun → `openNodeSqliteStorage` runs as-is. ✓
  - Crash-resume: closed the harness mid-generation on SQLite, reopened + `resume()`, the turn
    completed exactly once; `requestId` redelivery is idempotent; the interrupted partial is
    recovered as a separate (non-final) assistant entry. ✓
  - `ModelRuntime` from `@earendil-works/pi-coding-agent` **implements pi-ai `Models`** — reuse it
    as `HarnessOptions.models` so real credentials/catalog come from `~/.pi/agent` exactly like pi.
  - Fake-provider gotchas learned: `Usage` must be complete (`totalTokens`, `cost.{input,output,
    cacheRead,cacheWrite,total}`) or `addUsage` writes NaN; SQLite WAL sidecars (`-wal`/`-shm`)
    must be deleted together with the DB file in tests.

## Goals

1. `DurableAgentDriver` — a fourth `AgentPort` (after `RpcAgentDriver`, `ExtensionAgentDriver`,
   `SdkAgentDriver`) over one `Harness` + root conversation, behind an injectable factory (tests
   never load real credentials).
2. The omni tool surface ported to a pi-durable extension: `omni_repos`, `omni_sessions`,
   `omni_send`, `omni_replies`, `omni_worktree`, `pppi_profiles`, plus `CodingTools`
   (`read`/`write`/`edit`/`bash` via `NodeExecutionEnv`). Reuse `packages/omni/src/{repos,pigeon,
   worktree}.ts` logic as-is; port `OMNI_SYSTEM_PROMPT` as a section.
3. `--agent durable` on the standalone host (`apps/server/src/cli.ts`), SQLite storage at
   `~/.pppi/omni-durable.sqlite` (env-overridable for tests).
4. Tests that lock parity and the restart criterion.

## Non-goals

- MCP / codemode / skills on the durable omni (documented loss; a later `mcp-bridge` extension is
  separate work).
- The `"waiting"` dialog state (pi-durable has no extension-UI dialogs; hooks could rebuild it later).
- Any wire-protocol change; any change to repo sessions, pigeon flow, `packages/omni`, or the
  pi-ext hosts (`/pppi_gateway` stays RPC/extension).
- Making durable the default driver.

## Approach

### Files (all new unless noted)

- `packages/gateway/src/durable/durable-driver.ts` — `DurableAgentDriver implements AgentPort`.
  - Boot via injected factory `createDurableOmni(opts)` returning `{ harness, conversation, models }`
    (below). `start()` → boot → `watchEvents(harness, rootId)` → translate.
  - Event translation (`watchEvents` batches → driver events):
    `run_start`→state thinking; `message_update` with `text_delta` changes→state streaming +
    `assistant-delta` (stable per-message assistantId); `message_end`→`assistant-final` (only
    `stopReason === "stop"` finals; error/aborted → `notify` error, mirroring `session-driver`);
    `tool_execution_start/end`→`tool` events + state tool/streaming; `compaction_start/end`→state
    compacting; `run_end`→state idle; `agent_changed`→refreshStatus.
  - `AgentStatus.context`: approximated from `pi.usage` totals (`tokens` ≈ input+output) vs the
    model's `contextWindow` (documented approximation; pi-durable has no exact context usage API).
  - `thinkingLevels` from the current model's `thinkingLevelMap` keys.
  - `prompt(text, {deliver})` → `submit({type:"input", content, requestId: randomUUID(),
    whenBusy: deliver === "steer" ? "steer" : undefined})`; never rejects on busy (default queues,
    matching followUp semantics).
  - `abort()` → `conversation.abort()`; `compact()` → `conversation.compact(undefined)`;
    `newSession()` → `conversation.reset(undefined)` + notify (same conversation id — storage keeps
    history); `setModel/setThinkingLevel` → `configure()` + refreshStatus;
    `availableModels()` → `models.getAvailable()` mapped through existing `toModelInfo`;
    `history({before, limit})` → `conversation.entries` ascending; ts decoded from UUIDv7 entry ids
    (first 48 bits); text via existing `textFromUser`/`textFromAssistant` over `entry.model`.
  - `dispose()` → stop stream, `harness.close()`.
- `packages/gateway/src/durable/durable-omni.ts` — `defineExtension({ name: "omni", sections:
  [OMNI_SYSTEM_PROMPT], tools: [...] })`. Tool bodies delegate to `@pppi/omni` logic modules
  (`repos.ts`, `pigeon.ts`, `worktree.ts`) and `packages/gateway/src/profiles.ts` for
  `pppi_profiles`. Pigeon identity: fixed session id `pppi-omni-durable` (env `PI_SESSION_ID` for
  `pigeon()` calls, marking `me` in listings). Tool result content mirrors the current strings.
- `packages/gateway/src/durable/boot.ts` — `createDurableOmni({ cwd, storage, models? })`:
  dynamic-imports pi-durable + pi-coding-agent (`ModelRuntime.create()`), builds the registry
  (`createRegistry()` + `CodingTools` + omni extension), `NodeExecutionEnv` per call from the
  conversation cwd (default `cwd`), opens storage (`openNodeSqliteStorage` default; `PPPI_DURABLE_STORAGE=jsonl:<dir>|memory` override for tests),
  `Harness.open` + `resume()` + `root({ agent: { cwd } })`.
- `packages/gateway/src/index.ts` (edit) — export the driver + boot.
- `apps/server/src/cli.ts` (edit) — `--agent durable` branch.
- `packages/gateway/test/durable-driver.test.ts` — see criteria.
- `packages/gateway/test/helpers/fake-provider.ts` — scripted `Provider<"pppi-test-api">` (complete
  `Usage` shape; delta→done streams; a "gated" mode whose `done` waits on a promise for the
  kill-mid-turn test).
- `README.md` (edit) — new "Durable omni (experimental)" subsection.
- `docs/plan/pi-1.0-and-durable.md` (edit) — phase 4 status: pilot shipped.
- `package.json` / `bun.lock` (already edited) — pi-durable/pi-ai/chord as root devDependencies
  (dynamic-import chain, same pattern as the SDK spike).

### Key patterns followed

- `SdkAgentDriver` (`sdk-driver.ts`): factory injection, EventEmitter → AgentPort, parity test
  shape, `normalizeIds` event-log comparison.
- `RpcAgentDriver`: prompt retry semantics not needed (submit never races), but the
  `state`/`status`/`info` getters and event vocabulary are copied verbatim where possible.
- `toModelInfo` / `textFromUser` / `textFromAssistant` / `toolLabel` reused from `agent.ts`.

## Risks & tradeoffs

- **Experimental upstream API** ("changes without notice") — contained behind `--agent durable`
  and the factory seam; default drivers unchanged.
- **MCP/codemode/skills loss on the omni** — accepted for the pilot, documented in README.
- **Context usage is approximated** (usage totals vs contextWindow) — status bar shows it as such.
- **Same-process coupling**: a pi-durable crash takes the gateway (like the SDK driver, unlike the
  RPC child). Accepted: durability is the point.
- **One storage per process**: the gateway owns `omni-durable.sqlite`; no second writer.

## Acceptance criteria (each test-locked unless noted)

1. `bun run dev:server -- --agent durable` boots: driver ready, omni tools + CodingTools installed,
   storage file created under `~/.pppi` (manual smoke; automated equivalents below).
2. Scripted turn → driver emits `state: thinking→streaming→idle`, `assistant-delta`,
   `assistant-final` with the scripted text; `history()` returns it newest-last.
3. **Restart survival**: gated provider; driver A disposed mid-generation (harness closed); driver
   B opens the same SQLite file, `resume()` completes the turn; exactly one final answer in the
   transcript; the recovered partial is not surfaced as a final.
4. `prompt(text, {deliver:"steer"})` while busy lands as `whenBusy:"steer"` (observed via the
   fake provider's received options/messages).
5. `omni_repos add/list` against a temp `PPPI_DIR` through the ported extension (stubbed pigeon
   binary absent → sessions line degrades gracefully, as today).
6. `newSession()` clears the visible transcript (model context reset) and history reflects it.
7. Repo layer untouched: `packages/omni/**`, pigeon flow, wire protocol all unchanged (diff
   shows it).
8. `bun run test` green (all existing suites + new); `tsc --noEmit` shows only the pre-existing
   onnxruntime/vad errors; `biome check` clean on every touched file.

## Open questions

None blocking — MCP loss for the pilot was accepted in conversation; everything else has a
default recorded above.

## Implementation notes (recorded during the build)

- `packages/omni/src/extension.ts`: `OMNI_SYSTEM_PROMPT` and `describeSessions` are now
  `export`ed (deviation from "repo layer untouched" — zero behavior change; the durable
  extension reuses them instead of duplicating).
- Entry ids in pi-durable 1.1 are storage-internal sequence numbers, not UUIDv7 — `entryTs`
  treats plain numerics as their own monotonic cursor.
- pi-durable **steers place at the next turn boundary** (after the current tool round);
  they do not inject into an in-flight model request the way pi 1.0 rpc
  `streamingBehavior: "steer"` does. Streaming feedback still works — the utterance
  remainder becomes the next turn — but the answer overlap the rpc mode can achieve is
  not available. Locked by the `whenBusy=steer` test.
- A conversation without a configured model starts no runs: `boot.ts` resolves pi's
  `defaultProvider`/`defaultModel` from `~/.pi/agent/settings.json`, falling back to the
  first available model (pi's own resolution order).
- Aborted partials recovered from an interrupted run appear in the transcript as
  `stopReason: "aborted"` assistant entries — the driver skips them in `history()` and
  never surfaces them as `assistant-final`.
- `message_update` deltas are diffs between committed partials (100 ms progress commits);
  the first partial's text arrives via `message_start`, not as a delta. TTS is unaffected
  (`assistantFinal` speaks the un-emitted tail).
