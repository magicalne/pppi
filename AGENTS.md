# AGENTS.md — sspi

**sspi is `**pi`**: a pointer-pointer to pi. One omni agent managing pi
sessions. Read README.md for the full picture.

## Ground rules

- **One conversation per screen, switchable target.** Clients never show
  multi-session UI (no split views, no session-list pages). They mirror one
  conversation at a time; the session switcher sheet only changes *which*
  session that conversation is with (omni by default, or a repo/worktree
  session).
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
- `apps/server/src/agent.ts` — pi RPC driver (framing, events, restart).
- `apps/server/src/stt.ts` — model resolution: `SSPI_STT_MODEL` →
  `~/.pi/agent/pi-transcribe.json` → HF-cache parakeet.
- `packages/protocol/src/index.ts` — the wire protocol; keep TS and Kotlin
  sides in sync.
