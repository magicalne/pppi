# pppi V1 — the full picture: a fleet of pi machines, paired clients, and agents with identities

**Date:** 2026-09-03 · **Status:** DRAFT — awaiting approval. **No code is written for V1 until this plan is approved.**

---

## 1. What we're building

Today pppi assumes one machine: the Mac runs a gateway with one omni pi
session, and web/Android mirror that single conversation. The full picture
promotes every axis:

```
Laptop ──┐                          ┌─ web (paired to N machines, switches via menu)
Server ──┼─ each runs: gateway + omni ─┆
Server ──┘   + repo/worktree pi        └─ android (paired to N machines, QR or link)
             sessions with PROFILES
             (name · color · description,
              visible to other agents)
```

- A **connection** = one machine (gateway + its omni). Clients hold a **list**
  of connections and switch between them from a **left menu** opened by a
  menu button just left of the Omni presence dot.
- **pi extensions with slash commands** are the glue, running in *any* pi
  session (terminal or gateway-spawned): `/omni` marks the omni, `/pair`
  prints a pairing QR + link in the terminal, `/profile` gives the session an
  identity.
- **Profiles** make agents identifiable: to humans via name + color
  (a reply from "Joe" renders in Joe's yellow), to other agents via
  `description` — which is what lets omni *choose* delegation targets
  ("who owns pigeon? Joe. Ask Joe.").
- Inside one machine nothing changes structurally: still one omni
  conversation, with the target switcher (tree drawer) for repo/worktree
  sessions.

Ground rules that still hold: secrets stay on the Mac (clients hold only
pairing tokens), voice-first, local STT, one conversation per screen, strict
JSONL RPC framing, TS/Kotlin protocol kept in sync.

## 2. Building blocks

### A. Connections (clients, multi-machine)
- Left-edge drawer, in front of chat, opened by a **☰ button placed left of
  the presence dot** (separate from the target pill, which keeps opening the
  session tree). Rows: machine name, profile-colored dot, online state.
- `+` adds a connection: **paste a pair link** (web + Android) or **scan a QR
  code** (Android). Opening a pair link on the web (`…/?pair=<token>`)
  auto-pairs.
- Connections persist per device (web: `localStorage`; Android: DataStore) as
  `{id, name, url, token}`. Switching connections swaps the WebSocket and
  reloads that machine's transcript. Unpair/remove per row.

### B. Pairing (gateway + `/pair`)
- Gateway binds `0.0.0.0`, discovers its LAN IPv4s, and writes
  `~/.pppi/pair.json`: `{machine, port, token, ips[], fingerprint}`. It prints
  the same QR + link at startup.
- **`/pair`** (pi slash command, works in any session on the machine) reads
  `pair.json` and renders a QR as terminal block characters plus the plain
  link `http://<ip>:<port>/?pair=<token>`.
- `GET /api/pair` returns the same payload for scripted setup.
- Trust model unchanged: LAN + bearer token, no TLS in V1.

### C. Omni marking (`/omni`)
- `/omni` in any pi session writes `~/.pppi/omni.json`
  (`{sessionId, cwd, pid, ts}`) — "this session is the machine's omni".
  Re-running it elsewhere moves the crown; the gateway attaches to the marked
  session. This is "spawn a pi agent in any place and make it the omni."

### D. Profiles + attribution (`/profile`)
- **`/profile`** — interactive in the TUI (`ctx.ui.input` / `ctx.ui.select`),
  every field optional: name, color (fixed palette picker), description,
  machine role. Anything omitted is auto-generated: name from hostname/repo
  dir, color hashed from session id, description written by the agent itself
  in one sentence.
- Stored per machine at `~/.pppi/profiles/<sessionId>.json`; the gateway
  merges them into `GET /api/sessions`, so clients get
  `{profileId, name, color, description}` per session. Agents see profiles
  through a small `profiles_list` tool registered by the same extension (and
  the pigeon registry keeps carrying `name`/`cwd`/`host` as today).
- **Attribution:** the gateway already knows which peer a delegated question
  went to (`sendToPeer(text, target)`). It tags the reply events with that
  peer's `profileId`. Clients render peer replies as a bubble tinted with the
  profile color and labeled with the profile name (Joe → yellow bubble,
  "Joe"). Omni's own answers stay omni-styled (open text with the accent
  dot).
- Colors: a fixed 10-hue palette, each with a fixed paired ink color,
  validated for contrast against all five themes (bubble uses the profile
  color as background, per the user's "Joe = yellow" example).

### E. Target switcher tree (already designed, half-built)
- The Omni-pill tap opens the **indented tree drawer**
  (Omni → repo → `wt/*`), replacing the bottom sheet + visibility toggles.
  Full design: [session-switcher-tree-drawer.md](./session-switcher-tree-drawer.md).
  ⚠️ The web app is **mid-refactor** for this right now (`SessionDrawer`
  written, CSS not yet swapped, Android untouched) — Phase 0 finishes it so
  the tree is never left broken.

## 3. Protocol changes (v2 → v3, additive only)

| Addition | Why |
|---|---|
| `Profile { id, name, color, description }` | identities for sessions |
| `SessionsResponse` gains `profiles: Record<sessionId, Profile>` | drawer rows + bubble colors |
| `assistant_final` / peer reply events gain optional `profileId` | attribution |
| `PairInfo { machine, url, token, fingerprint }` + `GET /api/pair` | pairing |
| no breaking renames; Kotlin DTOs updated in the same phase | TS/Kotlin sync rule |

## 4. Phases

| # | Phase | Contents | Size |
|---|---|---|---|
| 0 | **Finish the tree switcher** | Complete `apps/web` drawer CSS + Android overlay drawer + PRD §4 update + verify (per the switcher plan doc). Leaves the repo green. | S |
| 1 | **Gateway + protocol v3** | `packages/protocol` additions; gateway binds `0.0.0.0`, writes `pair.json`, `/api/pair`, startup QR; profiles merged into `/api/sessions`; peer-reply attribution tagging; unit tests for classify/attribution. | M |
| 2 | **`packages/pi-ext`** | One extension registering `/omni`, `/pair`, `/profile`, `profiles_list` tool, auto-profile generation; `pppi install-ext` copies it to `~/.pi/agent/extensions/pppi/` (pi's extension dir — verified). Tested in a real TUI pi session (QR legible, profile flow) and in RPC mode (hasUI path). | M |
| 3 | **Web: connections + bubbles** | ☰ button + connections drawer; multi-connection store; `?pair=` onboarding; per-connection transcript swap; profile-colored peer bubbles + names. Verified in the live browser. | M |
| 4 | **Android: connections + QR** | ☰ button + connections drawer (same overlay style as the tree drawer); `+` → paste link or scan QR (`zxing-embedded` — no Play Services dependency); DataStore; profile bubbles. Instrumented tests + emulator screenshots. | L |
| 5 | **Delegation polish + E2E** | omni's context gets profiles (description-driven delegation), tool chip `asking Joe…` already exists → label uses profile name; extend `e2e.py`: second connection pairs via link, profile flow, attribution bubble; full green run; AGENTS.md + README updated. | M |

Dependency order: 0 → 1 → 2 → 3 → 4 → 5. (3 and 4 could swap; 2 before 3/4
so pairing can be tested against real `/pair` output.)

## 5. Decisions (defaults apply unless you say otherwise)

| # | Decision | Default |
|---|---|---|
| D10 | Connections menu shape | left drawer from the screen edge, in front of chat; ☰ button left of the presence dot |
| D11 | Pairing transport | plain HTTP on LAN, token in link/QR; no TLS in V1 |
| D12 | QR rendering | terminal: `qrcode` npm (block chars); Android: zxing-embedded |
| D13 | Profile storage | `~/.pppi/profiles/<sessionId>.json` per machine; pigeon registry untouched |
| D14 | Color palette | fixed 10 hues + paired inks, contrast-checked on all 5 themes |
| D15 | Omni count | one per machine; `/omni` re-mark moves it |
| D16 | Extension packaging | `packages/pi-ext`, installed into `~/.pi/agent/extensions/pppi/` |
| D17 | Attribution granularity | gateway tags delegated replies with the target's profile; omni's own summary stays omni-styled |
| D18 | Connections sync across devices | no — per-device lists in V1 |

## 6. Explicitly later (not this plan)

- More skills/slash commands beyond the three (`/status`, `/spawn`,
  `/assign`, `/handoff`), cross-machine pigeon relay (agent-to-agent across
  machines), TLS/remote (non-LAN) pairing, connection sync, markdown chat
  rendering (still a cheap independent win whenever you want it).

## 7. Repo state right now

- `apps/web/src/App.tsx` is mid-refactor for the tree drawer (does not compile
  until Phase 0 finishes it). Android/PRD for the switcher untouched.
- Gateway currently running on :8787 (E2E setup), emulator up and paired —
  both will be reused for verification.
