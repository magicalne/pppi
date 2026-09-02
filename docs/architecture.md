# sspi architecture

```
                      Mac (secrets live here)
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  terminal pi ──┐                                              │
│                │   ┌─────────────┐    RPC JSONL (stdio)       │
│  web ──WS──►   ├───│  sspi server │◄──► omni session         │
│  android─WS──► │   │  (gateway)   │     pi --mode rpc        │
│                │   │  local STT   │     -e extensions/omni.ts│
│                │   └─────────────┘                          │
│                │                         │ pigeon          │
│                │                         ▼                 │
│                │   repo sessions (pi, main branch)          │
│                │     └─ worktrees (.worktrees/, wt/*)       │
└───────────────────────────────────────────────────────────────┘
```

## Decisions

1. **The omni agent is a pi session, not a service.** It gets the omni
   extension and its system prompt from the extension itself
   (`before_agent_start`). A headless instance is spawned by the gateway
   (`pi --mode rpc --session-id sspi-omni`), an interactive instance is just
   `pi -e extensions/omni.ts`. Same tools, same persona.

2. **Client↔gateway is a dumb mirror.** The gateway owns THE session.
   Clients authenticate with a pairing token, then receive every event
   (deltas, tool runs, state) and can submit voice/text. No client-side
   session logic, no secrets beyond the token.

3. **Voice is transcribed on the Mac.** Clients upload 16 kHz mono PCM16
   WAV; the gateway decodes, resamples defensively, and runs
   `transcribe.cpp` with the parakeet model from pi-transcribe's catalog
   (resolved: `$SSPI_STT_MODEL` → pi-transcribe's config → HF cache).
   Zero cloud, zero keys.

4. **Inter-session messaging is pigeon's job.** The omni extension never
   spawns agents itself; it discovers sessions from pigeon's registry,
   resolves repo → session by cwd, sends async tasks, and collects replies
   from its mailbox. Worktrees are plain `git worktree` management —
   sessions in a worktree are still just sessions (pigeon sees their cwd).

5. **Strict JSONL framing.** pi RPC is LF-delimited JSON; the driver splits
   on `\n` only (never readline) and auto-dismisses extension dialogs so a
   headless agent can never block on a TUI prompt nobody will answer.

## Failure posture

- Gateway restarts → `--session-id sspi-omni` resumes the same session file.
- Agent crash → driver respawns with backoff; clients see an error toast.
- Undelivered pigeon messages survive (durable inbox spool).
- STT model missing → `/api/health` says so; voice upload returns 503 with
  setup instructions; chat keeps working.
