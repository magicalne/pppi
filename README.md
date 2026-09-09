# pppi

```
        ┌──────┐         ┌──────┐         ┌──────┐
        │ pppi │ ──────► │  *p  │ ──────► │  pi  │
        └──────┘         └──────┘         └──────┘
       pointer ──► pointer ──► pi
```

**pppi is `**pi` — a pointer to a pointer to [pi](https://pi.dev).** Don't talk to
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
| **Android** | the `pppi` app — hold-to-talk voice first |

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

- TTS provider is pluggable: `PPPI_TTS_PROVIDER=kokoro|macos-say|auto`,
  model dir via `PPPI_TTS_MODEL` (layout: `config.json`, `onnx/
  model_quantized.onnx`, `voices/af_heart.bin`). Download:
  `huggingface-cli download onnx-community/Kokoro-82M-v1.0-ONNX --include
  "onnx/model_quantized.onnx" "voices/af_heart.bin" "config.json" "tokenizer*"`
- Timing knobs live in `packages/gateway/src/vad.ts` (`DEFAULT_TIMINGS`).
- Magic words never become turns: `stop` (also `cancel`, `quiet`) cuts
  playback and aborts the agent; `repeat` (also `say that again`) re-speaks
  the last reply without a model round trip.
- Interactive mode is a named state machine on every client — connecting →
  warming (real boot progress from the audio service: `__voice_boot__`
  frames, `/api/health` `boot` field) → routing (Bluetooth SCO) → listening —
  with timeouts, cancel-on-tap in every state, and auto-reconnect (twice)
  on mid-session drops. The models load eagerly at server boot, so the
  first utterance never pays the load cost.
- Sessions auto-pause after 10 idle minutes; hold-to-talk stays as the
  fallback whenever the session is off.

### Status bar (context · model · thinking effort)

Under the composer on web and Android: context usage as
`used/total (used%)`, the current model, and a brain icon whose brightness
is the thinking effort (dim = off, fully lit = max). Press-hold the brain
and swipe to change effort; tap the model name to pick from **your pi
enabled models** — the same list pi's own picker builds from
`enabledModels` in `~/.pi/agent/settings.json`. Switching model or effort
goes through the omni session's pi over RPC and is echoed back as one
`status` snapshot (protocol v5), so every screen updates together.

## Layout

```
pppi/
├── extensions/omni.ts       # what pi loads (-e) — the omni extension entry
├── packages/
│   ├── gateway/             # gateway core: wire transport, voice stack, pi rpc driver
│   ├── omni/                # omni core: repo registry, worktrees, pigeon bridge, pi tools
│   ├── pi-ext/              # pi extension: /omni /pair /profile — /omni boots the gateway
│   └── protocol/            # shared wire protocol (server ⇄ clients)
├── apps/
│   ├── server/              # standalone gateway host (headless/daemon cli)
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

# 2. install the pi extension (also ships the gateway runtime for /omni)
bun run install:ext

# 3a. start the gateway from any pi session — type /omni in pi
#    → prints the LAN URL + QR; clients pair while that session lives
#    (or run the standalone host: bun run dev:server -- --host 0.0.0.0)
#    → both read the same ~/.pppi/config.json token, so clients stay paired

# 3b. or make THIS pi session the omni itself (/omni here)
#    → no child session; the terminal and clients mirror one conversation

# 4. talk to it
#    web:   open http://<mac>:8787 on any device, paste the token once
#           (or open the printed pair link — it ends in /?pair=<token>)
#    phone: install apps/android APK, tap ☰ → Scan QR on the /pair QR,
#           or paste the pair link
#    terminal: the /omni here session IS a terminal screen
#
#    on Android, interactive mode picks up your Bluetooth/wired headset
#    automatically (BT needs the BLUETOOTH_CONNECT grant on 12+) and a
#    foreground service keeps the conversation alive with the screen off.

# 5. teach the omni agent about your repos (say: "register ~/Workspace/opensource/pppi")
#    or use the omni_repos tool directly
```

The headless omni session persists across gateway restarts (`--session-id
pppi-omni`). To run an interactive omni session in a terminal, load the same
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
`pppi_profiles` tool: descriptions are how an omni decides *whom* to delegate
to.

The `pppi` pi extension (`packages/pi-ext/`) provides the commands; install
once with `bun run install:ext` (copies it to `~/.pi/agent/extensions/pppi/`):

| Command / tool | Purpose |
|---|---|
| `/omni` | boot the gateway from this session (clients pair while it lives); the omni is an rpc child |
| `/omni here` | this session itself becomes the omni — terminal and clients mirror one conversation (asks first if history exists) |
| `/omni mark` | tag this session as the omni target the child attaches to |
| `/omni stop` | shut the gateway down |
| `/pair` | print the pairing QR + link for web/Android clients |
| `/profile` | set this session's name / color / description |
| `pppi_profiles` | tool: list profiles (agents read descriptions to pick targets) |

## Omni tools (what the agent gets)

| Tool | Purpose |
|---|---|
| `omni_repos` | register / list / remove managed repos (`~/.pppi/repos.json`) |
| `omni_sessions` | open pi sessions (pigeon registry) mapped to repos |
| `omni_send` | delegate a task to a repo's session (async, msgId ticket) |
| `omni_replies` | collect replies to sent messages |
| `omni_worktree` | create / list / remove git worktrees per repo |
| `/omni` | print the current hierarchy |

## Releases & the hosted web client

- **Android APK**: pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml)
  and attaches a signed `pppi-<tag>.apk` to a GitHub Release. Signing uses repo
  secrets (`PPPI_KEYSTORE_B64` / `PPPI_KEYSTORE_PASSWORD` / `PPPI_KEY_ALIAS` /
  `PPPI_KEY_PASSWORD`); without them the APK falls back to debug signing.
- **Web client on GitHub Pages**: pushes to `main` build `apps/web` to
  https://magicalne.github.io/pppi/ — no local web server needed. The bundle
  is static and pairs with any gateway: enter the gateway URL + token, or open
  a link shaped like `https://magicalne.github.io/pppi/?server=http%3A%2F%2F<mac>%3A8787&pair=<token>`.

> **Mixed-content caveat:** an `https://` Pages page cannot open `ws://` /
> `http://` connections to a plain-LAN gateway — browsers block it. Put the
> gateway behind TLS for Pages use, e.g. with Tailscale (both devices on the
> tailnet): `tailscale serve --bg --https=443 http://localhost:8787`, then pair
> the Pages client with `https://<mac>.<tailnet>.ts.net` (valid certs, `wss://`
> works). On the same LAN, the gateway's own served client (no TLS needed)
> remains the simplest path.

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
