# pppi UI Design PRD — "Talk to a person, not a terminal"

Status: **DRAFT for review** · Scope: web + Android (one design, two implementations) · Baseline: mobile 390px

---

## 1. Goal

You should feel like you're messaging a capable colleague named **Omni**, not
operating a coding agent. Every choice below serves three feelings:

1. **Presence** — Omni (and every session) feels *alive*: it visibly breathes,
   thinks, and works, one line at a time.
2. **Calm** — one conversation, one input, one glanceable status. Nothing
   shouts. No terminal chrome.
3. **Reachability** — voice is a thumb-press away, sending is Enter, switching
   context is one tap on a name.

Anti-goals: IDE aesthetics, dashboards, log viewers, multi-pane layouts.

> **Ground-rule note.** AGENTS.md says clients never add multi-session UI.
> This design keeps that spirit: the client still shows **one conversation at
> a time**. The session tree is a *target switcher* (who am I talking to), not
> a session list page. Deciding this explicitly — chosen direction below.

---

## 2. Information architecture

```
Main screen (the only screen)          Overlays (drawn in front of chat)
┌───────────────────────────┐
│ presence bar  [target ⌄]  │──tap──► Target tree drawer (from the pill)
│ one-line live status      │
├───────────────────────────┤
│                           │
│   conversation            │
│                           │
├───────────────────────────┤
│ [input ............ (mic)]│──Enter / IME send
└───────────────────────────┘
        │ palette icon ────────► Appearance page (web: /themes, tab;
        │                         Android: full-screen settings page)
```

- **Desktop web** is not a separate layout: the same column, centered,
  `max-width: 680px`, more whitespace. Mobile-first means mobile decides.

---

## 3. Presence bar (header)

```
╭──────────────────────────────────────╮
│  ◉  Omni                       ⌄     │
│     thinking…                        │
╰──────────────────────────────────────╯
```

- **Left:** presence dot (6px) + target name. Dot colors: green = idle &
  listening, pulsing accent = working, gray = offline/connecting.
- **Second line:** the **live status** — always exactly one line (see §5).
  This is the heartbeat of the whole design.
- **Right:** small chevron. Tapping *anywhere on the bar* opens the session
  switcher. The bar also doubles as a breadcrumb: when you're talking to a
  worktree session it reads `ss · fix-auth`, not `Omni` (worktrees show their
  bare worktree name — no `wt/` prefix in the UI; the git branch stays `wt/*`).
- **Far left: the ☰ machines button.** It opens the *machines drawer* (§3b).

---

## 3b. Machines drawer (connections)

One connection = one machine (gateway + its omni conversation). The drawer
slides from the left edge, **in front of the chat**, and lists every paired
machine: profile-colored dot + machine name; the active row is highlighted.
`+`/the add form pairs a new machine by **pair link** (`http://ip:port/?pair=token`)
or by **QR scan** (Android). Rows can be removed (✕ = unpair this device).
Switching connections swaps the WebSocket and that machine's transcript —
secrets rules unchanged (clients hold only pairing tokens).

## 4. Target tree drawer (from the pill, in front of chat)

```
   tap the target pill ("Omni ⌄") and the tree drops from right below it:

   ╭────────────────────────────────╮
   │ SESSIONS                       │
   │ ◉ Omni              the fleet  │   depth 0
   │ │ ◉ pppi            working…   │   depth 1 = repo (= its main session)
   │ │ │ ◉ fix-auth      idle       │   depth 2 = worktrees (bare name)
   │ │ │ ◉ perf         reading…   │
   │ │ ◉ pigeon           idle      │
   │ │ ◉ notes — no open session   │   dim, not tappable
   │ ────────────────────────────── │
   │ Unpair this device             │
   ╰────────────────────────────────╯
   (scrim over the conversation; tap outside closes)
```

- **A tree, always expanded** — a list of lists with indentation. No
  visibility toggles: Omni first, repos under it, worktrees one level deeper.
  Faint vertical guide lines mark each ancestor level.
- A repo row **is** its main session (label = bare repo name); non-repo
  sessions ("others") sit at depth 1.
- Each row: name + **its own one-line live status** (same grammar as §5).
- The active row gets an accent bar + surface tint — you always know who
  you're talking to.
- Selecting a row switches the conversation view to that session's transcript
  and closes the drawer. *(Implementation note: the gateway will need a
  per-session mirroring API — out of scope for this PRD, tracked separately.)*
- Empty states are honest: "<repo> — no open session".
- The drawer is anchored to the pill you tapped (web: absolute under the
  header; Android: overlay below the presence bar) and floats **in front of
  the chat history**.

---

## 5. Live status line — the grammar

Exactly one line per session, present tense, lowercase, with a verb. Verbs
come from the session's real activity (pi events), mapped:

| Underlying state      | Copy                       | Motion            |
|-----------------------|----------------------------|-------------------|
| thinking (no tool)    | `thinking…`                | breathing dots    |
| tool: read/glob/grep  | `reading src/agent.ts`     | tiny book icon    |
| tool: write/edit      | `writing tests/e2e.spec`   | tiny pencil icon  |
| tool: bash            | `running bun test`         | tiny spinner      |
| streaming text        | `typing…`                  | blinking caret    |
| pigeon send/reply     | `asking pppi · main…`      | tiny arrow        |
| idle                  | (blank — quiet is polite)  | none              |
| error                 | `hit a snag — tap to see`  | rose dot          |

Rules: truncate the object to one line, never wrap; max update rate 4/s; the
status of the *current target* is mirrored in the presence bar; other
sessions show theirs only inside the switcher.

---

## 6. Conversation rendering

```
│                              ╭───────────────────────────╮
│                              │ is the build green?       │
│                              ╰───────────────────────────╯
│
│  Yep — 264 passing, 0 failing.
│  Want me to write the report?
│
│  ⚙ ran bun test · 12s                    ← tool chip, collapsed
│
│  Done. Two files touched, both in
│  apps/server.
```

- **User messages**: right-aligned, soft accent-tinted bubble, 20px radius
  (4px tail corner). This is "what I said".
- **Assistant messages**: left, **no bubble** — open text with a small
  presence dot beside the first line. Open text reads as a person talking;
  bubbles read as blocks of output. Long answers get real paragraph spacing.
- **Tool calls** collapse to one-line chips (`ran bun test · 12s`), tappable
  to expand output in a monospace block. Never auto-expanded.
- **Voice messages you sent** show a tiny mic glyph before the text.
- Timestamps: only on day boundaries and on long-press/hover, never per
  message. A real chat doesn't timestamp every line.
- Streaming: assistant text grows with a soft caret; when the turn ends the
  caret disappears. No "Regenerate/stop" chrome except a small stop pill that
  appears only while working (top of composer).

---

## 7. Composer (inline, voice-first)

```
╭──────────────────────────────────────────╮
│  Message Omni…                    ((●))  │
╰──────────────────────────────────────────╯
```

- **One pill**, full width. Text field and voice button live *inside* it.
- **No send button.** Enter sends on web (desktop + attached keyboard). On
  Android the IME action is *Send* (the keyboard's own send key). Shift+Enter
  makes a newline.
- **Voice button** docks at the right end of the pill, always visible:
  - idle: mic glyph
  - pressed/recording: pill expands — the field is replaced by a live
    waveform + "listening… release to send", mic glyph becomes ■ stop
  - while Omni is working, the pill shows a thin progress hairline on top
- Placeholder copy is a person's invitation, rotating gently:
  "Message Omni…", "Ask about a repo…", "Tell Omni what to build…" (only in
  empty state, never while typing).
- Max height ~5 lines, then internal scroll.

### 7b. Interactive mode (hands-free conversation)

Tapping the mic opens a **voice session**: the field is replaced by the
conversation's state, in the live-status grammar. Tap ■ (or leave it idle
long enough) to end.

```
╭──────────────────────────────────────────╮
│  listening — just talk              (■)  │
│  I heard you say some of it …       (■)  │   live caption while speaking
│  thinking…                          (■)  │
│  talking… speak up to interrupt ⏹   (■)  │
╰──────────────────────────────────────────╯
```

- States mirror the person grammar: `listening` → user caption →
  `thinking…` → `talking…` → `listening`. The caption renders the settled
  words bold and the in-flight tail dim — what the machine hears is never a
  secret.
- **Talking over the agent is the interrupt.** Speech during `talking…`
  cuts the audio instantly (the server decides; thresholds are echo-aware)
  and the cut answer is discarded — "if it didn't finish saying it, it
  never said it". A `stop` button is also there for noisy rooms.
- Spoken answers are prose only: fenced code is announced as "code is on
  the screen"; the full answer still renders in the thread.
- Turn-taking constants (silence endpoint, grace merge, blip filter) live in
  `apps/server/src/vad.ts` — the UI renders whatever the state machine says,
  never its own timer.

### 7c. Status bar — context · model · thinking effort

One quiet row under the composer, always visible. It describes the agent
that will answer: when a repo/worktree peer is targeted, the model and brain
controls disable and context reads "—".

```
│  🧠  37.2k/400k (9%)                      Claude Opus 4.8  ›  │
```

- **Context** in `used/total (used%)` — k/m units, `—` right after
  compaction, percent turns `danger` at ≥ 85% (auto-compaction handles the
  rest; the bar only hints).
- **Brain = thinking effort.** Brightness IS the level: dim outline at
  `off`, accent fill ramping 25% → 100%, fully lit at `max`. pi's canonical
  ladder (`off minimal low medium high xhigh max`) drives everything;
  per-model support comes from the server, unsupported levels never render.
- **Adjusting is one gesture: press-hold, swipe, release.** The track slides
  out over the context text; the thumb snaps between the model's supported
  stops (tick haptic on Android); the brain live-previews the stop under the
  finger; a chip names the level (with the provider-native value dimmed when
  it differs, e.g. `off · none`). Release commits. A plain tap commits
  nothing — a stray tap must not silently wrap `max → off`.
- **Model name opens the enabled-models sheet** — exactly pi's own list
  (auth-available ∩ `enabledModels` in pi settings), `name` + dim
  `provider · context`, current model checked. Picking switches the omni
  session's model; pi's own validation is the source of truth.
- Everything reaches the client as one `status` snapshot (protocol v5);
  clients are dumb mirrors that re-render on each push.

---

## 8. Theme system — five schemes, one picker page

All colors are design tokens (CSS custom properties on web / Compose palette
on Android). The **Appearance page** (`/themes` on web — its own tab; a
full-screen page on Android) shows the five themes as live mini-previews of
the actual chat screen; one tap switches and persists. Fonts and sizes are
global, not per theme.

### Tokens (per theme)

`bg · surface · text · text-dim · accent · accent-ink · user-bubble ·
user-bubble-ink · line · danger`

### The five schemes

**1. Dusk — warm dark (recommended default)**
Feel: a dim study, lamplight. The "real person" mood at night.
`bg #171412 · surface #201C19 · text #F2EAE0 · dim #9A8F83 · accent #E8965A ·
accent-ink #1A130C · user-bubble #2E2823 · user-bubble-ink #F2EAE0 ·
line #2B2622 · danger #E5484D`

**2. Dawn — warm light**
Feel: morning paper. Same warmth as Dusk, daylight.
`bg #FAF6F0 · surface #FFFFFF · text #2A2620 · dim #8A8177 · accent #D96C47 ·
accent-ink #FFFFFF · user-bubble #F5E7D8 · user-bubble-ink #4A3F33 ·
line #EAE2D8 · danger #C62A2F`

**3. Slate — cool dark**
Feel: tonight's current look, refined — for people who want "engineer" but
softer.
`bg #0E1116 · surface #151A21 · text #E6EDF3 · dim #8B949E · accent #7AA2FF ·
accent-ink #0B1020 · user-bubble #1C2740 · user-bubble-ink #E6EDF3 ·
line #212833 · danger #F2555A`

**4. Paper — editorial light**
Feel: a blank page and a pen. Monochrome, accent is ink-black.
`bg #FFFFFF · surface #F6F6F4 · text #141414 · dim #6B6B6B · accent #141414 ·
accent-ink #FFFFFF · user-bubble #EFEFEC · user-bubble-ink #141414 ·
line #E6E6E2 · danger #C62A2F`

**5. Matcha — calm green light**
Feel: greenhouse. Gentle, distinct from Paper.
`bg #F3F7F0 · surface #FFFFFF · text #22301F · dim #7A8873 · accent #5B8C51 ·
accent-ink #FFFFFF · user-bubble #E3EDDC · user-bubble-ink #2A3A26 ·
line #DFE8D8 · danger #C62A2F`

Picker page shows each as a miniature chat mock (same components, scaled),
name + one-word mood, current one ringed. Switching is instant, stored in
`localStorage` / Android preferences, and follows `prefers-color-scheme` only
until the user chooses once.

---

## 9. Typography & spacing

- **UI + chat font:** Inter (variable), fallback `-apple-system, Segoe UI,
  Roboto`. Warm alternative if you want softer: **Manrope**. Decide once,
  both themes ship with the same type ramp.
- **Mono** (code, tool output): JetBrains Mono, 13.5px, only inside expanded
  tool blocks.
- Ramp: chat body **17px / 1.55** · meta & status 13px / 1.3 · presence name
  16px semibold · composer 17px · picker headers 20px semibold.
- Sentence case everywhere, lowercase status verbs. No all-caps labels.
- Spacing scale 4/8/12/16/24; screen side gutters 16px; composer bottom safe
  area respected (notch + gesture bar).

---

## 10. Motion & micro-interactions

- Presence dot "breathes" (scale 1→1.15, 2.4s loop) only while working.
- Status line changes cross-fade (120ms), never jump.
- New message: 160ms rise+fade. Send: bubble rises from the composer.
- Recording: waveform bars driven by real mic RMS (already have this).
- Theme switch: 200ms color cross-fade, no flash.
- Nothing bounces. Motion confirms, never decorates.

---

## 11. Accessibility

- All text ≥ 4.5:1 contrast in every theme (values above are chosen to pass;
  dim text is used only for ≥13px meta).
- Touch targets ≥ 44px (mic button is 48px tall inside the pill).
- Dynamic type: chat text scales with OS font size up to 1.3×; layout wraps,
  never truncates messages.
- Status line is announced by screen readers as "Omni is <status>".

---

## 12. Android parity

Same information architecture, native stack:
- Presence bar → top app row; target tree drawer → scrim + overlay panel
  anchored below the presence bar; composer → pill with
  `KeyboardOptions(imeAction = Send)`; Appearance → full-screen page fed by
  the same five palettes as Compose `ColorScheme`s.
- One design source of truth: tokens table in §8 is copied 1:1 into Compose.

---

## 13. Decisions I need from you

| # | Decision | Options | My recommendation |
|---|----------|---------|-------------------|
| D1 | Default theme | Dusk / Dawn / Slate / Paper / Matcha | **Dusk**, with Dawn second |
| D2 | Which themes to ship in v1 | all five / cut to three | ship all five — they're cheap once tokenized |
| D3 | Assistant message style | open text (no bubble) vs bubble | **open text** (reads human) |
| D4 | Chat font | Inter vs Manrope | **Inter** (safer at small sizes) |
| D5 | Session switcher | bottom sheet vs tree drawer from the pill | **tree drawer from the pill**, drawn in front of chat (revised after review) |
| D6 | Worktrees hidden by default? | yes / no | **no — tree always expanded** (revised after review) |
| D7 | Status detail | verbs only (`reading…`) vs verb+object (`reading src/agent.ts`) | **verb+object** — one line, but concrete |
| D8 | Voice button side | right end of pill vs left | **right** (thumb reach, matches WeChat/WhatsApp instinct) |
| D9 | Persona name in UI | "Omni" fixed / user-renameable | **"Omni" fixed** for v1 |

Comment on any line — or just say "D1: Slate, rest as recommended" and I'll
turn this into implementation (tokens file, web redesign, Compose redesign,
themes page) in that order.
