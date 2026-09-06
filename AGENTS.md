# AGENTS.md — sspi

**sspi is `**pi`**: a pointer-pointer to pi. One omni agent managing pi
sessions. Read README.md for the full picture.

## Ground rules

- **One conversation per screen, switchable target.** Clients never show
  multi-session UI (no split views, no session-list pages). They mirror one
  conversation at a time; the target tree drawer (from the Omni pill) only
  changes *which* session that conversation is with (omni by default, or a
  repo/worktree session). The ☰ machines drawer switches *which machine* —
  one connection = one machine's omni conversation.
- **Secrets stay on the Mac.** Clients hold only the pairing token. Never
  ship provider keys, never log them, never echo env secrets through agent
  replies.
- **Voice first.** Any new client feature must work with hold-to-talk first;
  text input is the fallback. Enter/IME-send always sends; no send buttons.
- **Two layers, no shortcuts.** omni → repo sessions (pigeon), repo →
  worktrees (git worktrees under `.worktrees/` on `wt/*` branches).
- **Local STT only.** The voice path uses transcribe.cpp GGUF models
  (parakeet-unified-en-0.6b is the recommendation from pi-transcribe's
  catalog). No cloud STT.
- **Agents have identities.** Every pi session can carry a profile
  (name/color/description — `/profile` writes `$SSPI_DIR/profiles/`).
  Delegated replies render tinted with the agent's color and labeled with its
  name; descriptions are for other agents to pick delegation targets.
- **Design source of truth:** docs/design/ui-prd.md — five themes as design
  tokens (tokens.css on web, SspiThemes on Android), "talk to a person not a
  terminal" grammar for the live status line. New UI must use the tokens.

## Stack conventions

- TypeScript: bun workspaces (`apps/*`, `packages/*`), tab indentation,
  double quotes, 120 cols (biome). Strict tsconfig with
  `noUncheckedIndexedAccess`.
- pi extension API: `@earendil-works/pi-coding-agent` + `typebox`. Extensions
  load via jiti; relative `.ts` imports are fine.
- The RPC framing for `pi --mode rpc` is strict JSONL: split on `\n` only,
  strip a trailing `\r`. Never use `readline` for it.
- Android: Kotlin + Compose, single Activity, kotlinx-serialization with
  `type` discriminator mirroring packages/protocol.
- Tests run with `bun run test` (vitest). The real-STT test uses macOS `say`
  and skips when the model or platform is missing.

## Key files

- `packages/omni/src/extension.ts` — the omni tools the agent sees.
- `packages/pi-ext/` — the /omni /pair /profile commands + sspi_profiles tool
  (install: `bun run install:ext` → `~/.pi/agent/extensions/sspi/`).
- `apps/server/src/agent.ts` — pi RPC driver (framing, events, restart) plus
  the status-bar controls: `setModel`/`setThinkingLevel`/`availableModels`,
  context from `get_session_stats`, `status` events on hello/turn/set.
- `apps/server/src/server.ts` — broadcast plumbing; the model popup's list =
  `availableModels` ∩ pi's `enabledModels` (SettingsManager + minimatch,
  pi's own semantics; tests inject `enabledModelsProvider`).
- `apps/web/src/status/StatusBar.tsx` + `apps/android/.../StatusBar.kt` —
  the status bar (context, model sheet, brain slider; brightness = thinking
  level). Wire shapes live in packages/protocol (v5) and Protocol.kt.
- `apps/server/src/profiles.ts` — profile palette + explicit/derived profile
  merge (keep the JSON shape in sync with packages/pi-ext/src/store.ts).
- `apps/server/src/stt.ts` — model resolution: `SSPI_STT_MODEL` →
  `~/.pi/agent/pi-transcribe.json` → HF-cache parakeet. `openUtterance()`
  exposes parakeet's buffered streaming for live partials.
- `apps/server/src/tts.ts` — TTS providers behind `TtsProvider`
  (kokoro first via `kokoro-js`, `macos-say` fallback;
  `SSPI_TTS_PROVIDER=kokoro|macos-say|auto`).
- `apps/server/src/vad.ts` + `vadProcess.ts` — silero VAD in a host process
  (worker threads deadlock against kokoro's runtime) + the turn-taking state
  machine (`UtteranceDetector`, timings in `DEFAULT_TIMINGS`).
- `apps/server/src/voice.ts` — the /voice websocket: streaming utterances,
  keyword commands, sentence-chunked speaking (`Speaker`, speak-prose
  transform), barge-in.
- `apps/web/src/voice/` — web interactive mode (mic, ws client, WebAudio
  playback, `useVoice` state machine).
- `packages/protocol/src/index.ts` — the wire protocol; keep TS and Kotlin
  sides in sync (Kotlin mirror: apps/android/.../Protocol.kt).
