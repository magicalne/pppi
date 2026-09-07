# Gateway-as-extension: `/omni` boots pppi

## Goal

Today the gateway is a separately started process (`bun apps/server/src/cli.ts`).
This plan moves the gateway so a pi session can host it: type `/omni` in pi and
the machine's clients can pair — no separate terminal step. Three phases:

1. **Extract `packages/gateway`** — the transport-agnostic gateway core + the
   RPC agent driver, hosted by a thin `apps/server` cli. No behavior change.
2. **`/omni` boots the gateway** from the pppi pi extension, with the omni
   conversation still a child pi session driven over RPC. The host session is
   just the launcher.
3. **In-process omni** — the host session *is* the omni conversation; the RPC
   child is gone for this mode (`/omni child` keeps the launcher form).

The wire protocol and both clients (web, android) do not change in any phase.

## Architecture

```
packages/gateway            everything both hosts share
  createGateway(opts)       node:http + ws — routes, /ws, /voice, static web
  RpcAgentDriver            pi --mode rpc child (agent.ts as today)
  AgentPort                 the seam: what a gateway needs from "an agent"
  voice stack               voice.ts, stt.ts, tts.ts, vad.ts(+vadProcess), wav.ts
  config/profiles/pair      config.ts, profiles.ts, pair files

hosts
  apps/server/cli.ts        standalone (headless/daemon) — today's entry
  packages/pi-ext /omni     in-process gateway inside a pi session (phases 2+3)
```

`AgentPort` = the surface `server.ts` uses from the driver today: event
emission (`state`, `status`, `assistant-delta/-final`, `tool`, `notify`,
`error`, `info`), `info`, `state`, `status`, `cwd`, `prompt`, `abort`,
`setModel`, `setThinkingLevel`, `availableModels`, `history`. Two
implementations: `RpcAgentDriver` (phases 1–2, and `/omni child`) and
`ExtensionAgentDriver` (phase 3, drives the host session via the extension
API).

## Phase 1 — extract packages/gateway

- **HTTP layer swaps fastify → `node:http` + `ws`.** The extension host cannot
  resolve fastify plugins from `~/.pi/agent/extensions/pppi` (no node_modules
  registry), and vendoring fastify is unreasonable. The route set is small:
  GET `/api/health`, POST `/api/voice` (raw audio, bearer auth), GET
  `/api/sessions`, GET `/api/pair`, POST `/api/peer-reply`, static web dist,
  WS upgrades on `/ws` and `/voice`. ~100 lines of router replaces three
  fastify packages and makes the core runnable under bun *and* node.
- `apps/server` keeps only `cli.ts` (args, banner, QR, signal handling). Its
  tests move to `packages/gateway/test/` (adjusted: `app.inject` → real
  fetch/listen).
- Deps: `ws`, `minimatch`, `@pppi/protocol`, `@pppi/omni` (pigeon/repos),
  `@earendil-works/pi-coding-agent` (SettingsManager); voice deps
  (`transcribe-cpp`, `onnxruntime-node`, `kokoro-js`) move with the voice
  files.

## Phase 2 — `/omni` boots the gateway (RPC child)

- `pi.registerCommand("omni")` upgrades from "mark omni.json" to "start the
  gateway now". Marking stays (it selects which session the child attaches to).
- **Packaging**: `install.mjs` materializes an `ext/node_modules` for the
  gateway: `@pppi/gateway` (src + package.json), `@pppi/protocol`, `@pppi/omni`
  (pigeon/repos/worktree/extension), plus pure-JS runtime deps (`ws`,
  `minimatch`); copies `apps/web/dist` → `ext/web`. The extension loads the
  gateway via `createRequire` (same pattern as the vendored qrcode-terminal).
- **Gateway identity**: same `$PPPI_DIR/config.json` token and port as the cli
  host, so clients stay paired across host swaps. `/omni` first probes
  `GET /api/health` on the configured port: an answering pppi gateway → notify
  the URL (already running); else start in-process and print the QR + link via
  `ctx.ui.notify`. A single instance per machine (port lock by probe).
- **Voice in the extension host**: STT/VAD/TTS natives stay out of pi's
  process. The gateway spawns an **audio service child** (`vad` host process
  already exists for the same deadlock reason); `/voice` ws frames proxy to it
  over a local socket. Dependency resolution for the child follows a module
  path chain: ext `node_modules` → the pppi repo checkout (path stamped into
  the ext copy at install time) → `~/.pi/agent/npm/node_modules`. Each
  capability degrades independently (STT reason / macos-say TTS / inert VAD) —
  all already-supported states surfaced in `/api/health`.
- The launcher's omni child needs the omni tools: `-e` points at the copied
  `@pppi/omni` extension entry (pi aliases `@earendil-works/*` + `typebox` for
  extensions — proven by pigeon and the installed pppi ext).
- Lifetime: the gateway lives as long as the host pi session. The cli host
  remains the headless/daemon option.

## Phase 3 — in-process omni (ExtensionAgentDriver)

`/omni` (default) hosts the gateway against **this session**; `/omni child`
keeps the phase-2 launcher. The RPC event vocabulary in `agent.ts` is pi's own
extension event bus (RPC mode is a JSONL veneer over it), so the mapping is:

| AgentPort            | extension API                                              |
| -------------------- | ---------------------------------------------------------- |
| `prompt(text)`       | `pi.sendUserMessage(text, { deliverAs: "followUp" })` when busy |
| `abort()`            | `ctx.abort()`                                              |
| state / tool events  | `pi.on("agent_start"/"agent_settled"/tool events, …)`      |
| deltas / finals      | `pi.on("message_update"/"message_end", …)` (same shapes)   |
| `info`/`status`      | `ctx.model`, `ctx.thinkingLevel`, levels from `thinkingLevelMap` |
| context usage        | `ctx.getContextUsage()`                                    |
| `setModel`           | `pi.setModel(model)` (Model object from `ctx.modelRegistry`) |
| `setThinkingLevel`   | `pi.setThinkingLevel(level)` (clamped by pi)               |
| `history`            | `ctx.sessionManager` messages                              |
| refresh triggers     | `model_select`, `session_compact`, `session_info_changed`  |

- **Hosting guard**: `/omni` in a session that already has a real conversation
  (or whose cwd is a registered repo in the pigeon registry) asks for
  confirmation — a repo work session must not silently become the omni.
- The terminal TUI now renders the same conversation clients mirror — the
  "one conversation per screen" set gains its first terminal screen.
- The RPC driver and cli host stay for headless use; nothing in phases 1–2 is
  deleted.

## Decisions

- **D1**: Replace fastify rather than vendor it — the extension host forces
  the issue in phase 2 anyway, and node:http keeps the core dual-runtime.
- **D2**: One config (token/port) shared by both hosts; the extension host
  reuses it rather than minting a second identity.
- **D3**: Audio always runs outside pi's process in extension-hosted mode
  (kokoro × worker-threads deadlock already forced VAD out; transcribe/kokoro
  follow it). The cli host keeps today's in-process audio under bun.
- **D4**: `AgentPort` is the only seam — clients, protocol, and the voice wire
  format never learn which host or driver is live.
- **D5**: Graceful degradation per audio capability with reasons surfaced in
  `/api/health` and the `/omni` banner; never a hard failure for missing
  natives.
- **D6**: Phase-2 `/omni` keeps working exactly when a gateway is already up
  (notify, don't double-start).

## Verification per phase

- P1: full vitest suite green from the new package; cli host byte-compatible
  behavior (wire scripts against `:8787`); web build.
- P2: fresh pi TUI session → `/omni` → QR appears; browser + emulator pair to
  it; chat, model/thinking controls, status bar, and voice round-trip work;
  second `/omni` notifies instead of double-binding; cli host still runs.
- P3: same battery with the in-process driver; TUI conversation and client
  mirror stay in lockstep; `/omni child` still works; guard dialogs fire in a
  dirty session.

## As-built deviations

- **`/omni` default is the launcher; `here` is opt-in.** The plan flipped the
  default to here-mode, but the original ask ("a server is spawned when I
  send /omni") is the launcher form, and here-mode changes the session's
  identity — it stays an explicit `/omni here` with its guard.
- **enabledModels reads pi's settings.json directly**, not SettingsManager:
  the extension copy cannot rely on pi's module aliasing for
  `@earendil-works/pi-coding-agent`, so the gateway dropped that dependency
  entirely.
- **`prompt` asks pi (`ctx.isIdle()`)** rather than tracking a local
  isStreaming flag: an errored turn settles without the handler transition we
  expected, and a stuck flag queued every later message into followUp limbo.
- **The audio child prints one ready line on stdout** (port + stt/tts/vad
  health); the gateway kicks `ensure()` on health polls so a crashed child
  self-heals and /api/health converges to the truth.
- The install stamps `repo.json` (repo root) into the extension dir; native
  voice deps are symlinked from the repo so dev machines get the full stack
  while bare installs degrade per capability.
