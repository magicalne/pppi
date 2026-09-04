# sspi

```
        ┌──────┐         ┌──────┐         ┌──────┐
        │ sspi │ ──────► │  *p  │ ──────► │  pi  │
        └──────┘         └──────┘         └──────┘
       pointer ──► pointer ──► pi
```

**sspi is `**pi` — a pointer to a pointer to [pi](https://pi.dev).** Don't talk to
your pi sessions one by one in terminals. Run **one omni agent** and let it
manage the fleet. It's the same conversation on every screen: your terminal,
your phone, your browser.

## The hierarchy

```
omni pi session
├─ repo session (pi on main)      ── pigeon ── one pi session per repository
│   ├─ worktree wt/fix-auth       ── git worktree under .worktrees/
│   └─ worktree wt/perf            ── parallel work as branches, not tabs
├─ repo session (pi on main)
│   └─ …
└─ (you, from anywhere)
```

- **Layer 1 — omni → repos.** The omni agent discovers your open pi sessions
  through [pigeon](https://github.com/magicalne/pigeon), maps them to registered
  repos by working directory, and delegates work with async messages.
- **Layer 2 — repo → worktrees.** Each repo session manages parallel work as
  git worktrees under `<repo>/.worktrees/<name>` on branches `wt/<name>`.

## Three ways in, one session

| Client | How it talks to the omni agent |
|---|---|
| **Terminal** | `pi -e .../extensions/omni.ts` — a plain pi session with omni tools |
| **Web** | served by the gateway at `http://<mac>:8787` |
| **Android** | the `sspi` app — hold-to-talk voice first |

There is exactly **one** omni session. The mobile/web clients mirror it (they
cannot create sessions); the omni agent is expected to figure out what to do
next — not to be handed a session picker. Secrets (provider keys, tokens)
never leave the Mac: clients pair once with a gateway token, that's all they
ever hold.

## Voice is a first citizen

Speech is transcribed **locally on the Mac** with the same stack and the same
recommended models as [pi-transcribe](https://github.com/earendil-works/pi-transcribe)
(`transcribe.cpp` + `parakeet-unified-en-0.6b`, rank 1 in its catalog). Your
voice never leaves the machine, and there is no cloud STT bill. Text input
exists as a fallback, but the big round button is the point.

### Interactive mode (hands-free)

Tap the mic once and just talk. The gateway runs silero VAD (in its own
process) for turn-taking, streams your speech through parakeet's
**buffered streaming mode** so live captions appear while you speak, and
answers **out loud** through local TTS — kokoro-82M (q8 ONNX) when its model
is cached, else macOS `say`. Talk over the agent and it stops instantly
(barge-in with echo-aware thresholds); say "stop" and the same thing happens
without becoming a chat turn. Fenced code is never spoken — the voice says
"code is on the screen" and the full answer stays in the bubble.

- TTS provider is pluggable: `SSPI_TTS_PROVIDER=kokoro|macos-say|auto`,
  model dir via `SSPI_TTS_MODEL` (layout: `config.json`, `onnx/
  model_quantized.onnx`, `voices/af_heart.bin`). Download:
  `huggingface-cli download onnx-community/Kokoro-82M-v1.0-ONNX --include
  "onnx/model_quantized.onnx" "voices/af_heart.bin" "config.json" "tokenizer*"`
- Timing knobs live in `apps/server/src/vad.ts` (`DEFAULT_TIMINGS`).
- Sessions auto-pause after 10 idle minutes; hold-to-talk stays as the
  fallback whenever the session is off.

## Layout

```
sspi/
├── extensions/omni.ts       # what pi loads (-e) — the omni extension entry
├── packages/
│   ├── omni/                # omni core: repo registry, worktrees, pigeon bridge, pi tools
│   └── protocol/            # shared wire protocol (server ⇄ clients)
├── apps/
│   ├── server/              # gateway: single omni session (pi --mode rpc), local STT, pairing
│   ├── web/                 # single-session voice UI (React/Vite)
│   └── android/             # hold-to-talk app (Kotlin/Compose)
└── docs/                    # architecture notes
```

## Quick start

```bash
# 0. prerequisites: pi (>=0.84), bun, git, and pigeon for inter-session messaging
git clone https://github.com/magicalne/pigeon ~/Workspace/opensource/pigeon
ln -s ~/Workspace/opensource/pigeon/src/extension ~/.pi/agent/extensions/pigeon
ln -s ~/Workspace/opensource/pigeon/bin/pigeon ~/.local/bin/pigeon

# 1. install + build
bun install
bun run build:web

# 2. start the gateway (spawns the headless omni session)
bun run dev:server -- --host 0.0.0.0
#    → prints the LAN URL and the pairing token (stored in ~/.sspi/config.json)

# 3. talk to it
#    web:   open http://<mac>:8787 on any device, paste the token once
#           (or open the printed pair link — it ends in /?pair=<token>)
#    phone: install apps/android APK, tap ☰ → Scan QR on the /pair QR,
#           or paste the pair link
#    terminal: pi -e $PWD/extensions/omni.ts   (interactive omni session)

# 4. teach the omni agent about your repos (say: "register ~/Workspace/opensource/sspi")
#    or use the omni_repos tool directly
```

The headless omni session persists across gateway restarts (`--session-id
sspi-omni`). To run an interactive omni session in a terminal, load the same
extension; both flavors share the tools, and cross-session messaging rides on
pigeon.

## Machines, profiles, and the pi extension

**One machine = one connection.** Each machine runs a gateway with its own
omni. Clients keep a *list* of paired machines — the ☰ machines drawer on
web/Android switches between them; `+` pairs a new one by QR (Android) or
pair link (both). The gateway prints the QR and the pair link at startup, and
`/pair` reprints them from any pi session on the machine.

**Every session can have an identity.** Run `/profile` in any pi session to
give it a name, color, and description (all optional — missing fields are
auto-generated). The gateway merges explicit profiles with deterministic
derived ones and ships them to clients, so when the omni delegates work to
"Joe" in some repo, Joe's answer shows up as a **yellow bubble labeled Joe**
— on the phone and in the browser. Agents read the same profiles through the
`sspi_profiles` tool: descriptions are how an omni decides *whom* to delegate
to.

The `sspi` pi extension (`packages/pi-ext/`) provides the commands; install
once with `bun run install:ext` (copies it to `~/.pi/agent/extensions/sspi/`):

| Command / tool | Purpose |
|---|---|
| `/omni` | mark the current pi session as this machine's omni (gateway resumes it) |
| `/pair` | print the pairing QR + link for web/Android clients |
| `/profile` | set this session's name / color / description |
| `sspi_profiles` | tool: list profiles (agents read descriptions to pick targets) |

## Omni tools (what the agent gets)

| Tool | Purpose |
|---|---|
| `omni_repos` | register / list / remove managed repos (`~/.sspi/repos.json`) |
| `omni_sessions` | open pi sessions (pigeon registry) mapped to repos |
| `omni_send` | delegate a task to a repo's session (async, msgId ticket) |
| `omni_replies` | collect replies to sent messages |
| `omni_worktree` | create / list / remove git worktrees per repo |
| `/omni` | print the current hierarchy |

## Testing

```bash
bun run typecheck       # strict TS across TS packages
bun run test            # 19+ tests incl. real STT (skips without a model/mic)
bun run build:web

# android (JDK 17 + Android SDK required)
cd apps/android
./gradlew :app:testDebugUnitTest        # JVM: WavEncoder
./gradlew :app:connectedDebugAndroidTest            # Compose UI tests (needs an emulator)

# android system E2E — one command, full flow
apps/android/e2e/run.sh
# boots/reuses the emulator, builds, starts a throwaway mock gateway, then
# drives the real app over adb: pair (real UI) → chat round trip → voice
# upload → gateway down ("connecting…") → restart (auto-reconnect) → unpair.
# KEEP=1 keeps the emulator+gateway alive after the run; E2E_AVD/E2E_PORT to
# override the defaults. The voice upload pipeline is additionally proven by
# an instrumented test that feeds a real WAV through WavEncoder and asserts
# the gateway's parakeet transcript.
```

The STT test speaks with the macOS `say` CLI and transcribes it back with the
parakeet model — the full voice path, minus your mouth.

## Status

V0.1 skeleton that runs: gateway + web + android voice loop, omni tools over
pigeon, local parakeet STT. Next up: streaming partial transcripts, omni
session ↔ interactive session pairing, worktree sessions spawned per task.
