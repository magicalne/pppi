# Status bar — context, model, thinking effort

Bottom-of-screen status bar for the omni conversation: context usage, current
model, thinking effort. Model and thinking effort are tappable and update live.
Web first, then Android parity (same order as interactive mode).

---

## 1. What pi already gives us (verified in `@earendil-works/pi-coding-agent` RPC)

| Need | RPC command | Returns |
|---|---|---|
| Current model + thinking level | `get_state` | `model: {provider, id, name, reasoning, contextWindow, thinkingLevelMap}`, `thinkingLevel` |
| Switch model | `set_model {provider, modelId}` | the new `Model` (validated against available; errors "Model not found" otherwise) |
| Available models (auth-configured) | `get_available_models` | `{models: Model[]}` |
| Thinking levels for the current model | `get_available_thinking_levels` | `{levels: ThinkingLevel[]}` — already clamped to what the model supports |
| Set thinking level | `set_thinking_level {level}` | success (pi clamps invalid values itself) |
| Context usage | `get_session_stats` | `contextUsage: {tokens: number\|null, contextWindow, percent: number\|null}` — `null` briefly after compaction, until the next assistant reply |

Two corrections to your recollection, both in your favor:

- **There is no "ultra".** The top level is **`max`**.
- **pi already normalizes both providers onto one canonical ladder** — you
  remembered right that "pi has made some conversion". Everything in pi (and
  therefore in sspi) is expressed as:

  ```
  off · minimal · low · medium · high · xhigh · max
  ```

  `ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
  Per model, `thinkingLevelMap` converts to provider-native values; levels
  mapped to `null` (or absent for `xhigh`/`max`) don't exist for that model:

  | pi level | OpenAI native (`reasoning_effort`) | Anthropic native |
  |---|---|---|
  | off | `none` | thinking disabled |
  | minimal | `null` on all gpt-5.x (unsupported) | low budget |
  | low / medium / high | `low` / `medium` / `high` | `low` / `medium` / `high` (effort on adaptive models, budget on older) |
  | xhigh | `xhigh` — only codex / newer max-tier models | `xhigh` — only Opus 4.7+, Sonnet 5, Fable 5 |
  | max | `max` — only the newest (e.g. gpt-5.6-sol) | `max` — Opus 4.6+, Sonnet 4.6+ |

  So **the brain icon and its brightness are identical for OpenAI and
  Anthropic** (same canonical ladder). The provider difference shows up only
  as a dim suffix in the slider's drag chip (the native value pi will send),
  per your "keep pi's format" call.

### Model list follows pi's model list

pi's TUI model selector = `get_available_models` (models from providers you
have auth for), **filtered by `enabledModels` patterns in pi settings**
(`~/.pi/agent/settings.json`, glob-style: `openai/gpt-5.*`, `*sonnet*`,
optional `:level` suffix). We replicate exactly that on the server:
`SettingsManager.create(cwd, agentDir).getEnabledModels()` + the same
minimatch semantics (`provider/id` or bare `id`, case-insensitive). No
patterns configured → show all available (pi's behavior). Result: the popup
shows only models you enabled in pi's settings — never the full catalog.

---

## 2. Layout

One row, full width, directly under the composer, above the OS safe area.
13px meta type, `text-dim` ink, `line` hairline on top. Height 36px web /
40dp Android. Always visible (it describes the agent you're talking to).

```
┌──────────────────────────────────────────────────────────────┐
│ ━━━━━━━━━━━━━━━━━━━━━━━ composer / pill ━━━━━━━━━━━━━━━━━━━━ │
├──────────────────────────────────────────────────────────────┤
│  🧠  37.2k/400k (9%)                      Claude Opus 4.8  › │
└──────────────────────────────────────────────────────────────┘
```

- **Left — brain icon** (thinking effort, press-hold + swipe → level slider, §3).
- **Left of center — context** in your exact format `used/total(used%)`:
  `37.2k/400k (9%)`. Numbers: `< 1k` raw, otherwise `k`/`m` with one
  decimal. `tokens = null` (just compacted) → `—/400k (—)`.
  ≥ 85% renders the percent in `danger` — a quiet "context is filling up"
  cue; pi's auto-compaction handles the rest.
- **Right — model display name** (`Model.name`, e.g. "Claude Opus 4.8";
  falls back to `provider/id`), chevron hint, tap → model popup.

Both tap targets get the standard pressed-opacity; 44px min touch height
comes from the bar itself.

**Scope rule (one conversation per screen):** the bar always describes the
agent that will answer. Omni is the only session the gateway drives over
RPC, so when the tree drawer has a repo/worktree target selected, the model
and brain controls disable (40% opacity, no popup — that session's model is
its own) and the model slot shows the target name instead. Context reads
"—" for peers; we never show omni's context for a peer conversation.

---

## 3. Brain icon — brightness = thinking effort

A single brain glyph (Lucide's brain icon), `accent` strokes when lit,
`text-dim` underneath. Seven canonical levels → seven luminance steps. "The light should be lighter as
the thinking effort [rises]; max = fully lit":

| level | lit strokes | icon state |
|---|---|---|
| off | accent @ 0% | dim outline only — "no thinking" |
| minimal | accent @ 25% | faint glow |
| low | accent @ 40% | |
| medium | accent @ 55% | |
| high | accent @ 70% | |
| xhigh | accent @ 85% | |
| max | accent @ 100% | fully lit |

Implementation: the icon's stroke paths drawn twice — a `text-dim` base
layer (always visible) plus an accent layer whose `stroke-opacity` ramps;
web uses two `<g>` layers, Android the same paths via `PathParser`.
On top sits a soft **aura** that makes it read as light, not just color: a
blurred bloom of the accent strokes (drop-shadow on web, a blurred copy on
Android) plus a radial halo behind the glyph — both scale with the same
level table, so there is zero glow at `off` and a full warm halo at `max`.
During a swipe the aura live-previews the stop under the finger.
Model without `reasoning` → icon pinned to the "off" look; pressing it
toasts "this model doesn't do thinking" instead of opening the slider.

### Adjusting: press-hold + swipe, no popup

No sheet, no dialog — the slider grows **out of the brain itself**, music-
player HUD style:

```
        press 🧠 and hold, then swipe →

 normal ┆ 🧠  37.2k/400k (9%)      Claude Opus 4.8 ›┆
        ┌──────────────────────────────────────────┐
 held   ┆ 🧠 ├─●────────────┤ high                 ┆   ← context text fades out,
        ┆    off  low  med  high  xhigh  max      ┆      slider takes its place
        └──────────────────────────────────────────┘
             release here commits "high"
```

- **Press** on the brain → a track slides out to the right (~160ms, the
  PRD's cross-fade timing), covering the context text. Nothing is committed
  while it's merely open.
- **Swipe** left/right — the thumb **snaps between the model's supported
  levels only** (`get_available_thinking_levels`), distributed evenly across
  the track; unsupported levels simply aren't stops (gpt-5.1: `off · low ·
  medium · high`, four stops, nothing between). Tick marks + dim tick labels
  sit under the track. The brain **live-previews** the brightness of the
  stop under the thumb — brightness is the level, so the control teaches
  itself.
- A small chip above the thumb shows the canonical level name while
  adjusting (and lingers ~1s after release), so `xhigh` vs `max` is never a
  guess. When the provider-native value differs from the canonical name
  (from `thinkingLevelMap` — e.g. "off" sends `none` on OpenAI), the chip
  appends it dim: `off · none`. That's where the "two representations"
  lived in the old popup design — kept, one gesture earlier.
- **Release commits**: `set_thinking_level` goes out; the bar re-renders
  from the echoed `status`; the slider slides back and the context text
  fades in. A plain tap (no swipe) changes nothing.
- Pointer capture semantics: drag past the track edges clamps at the end
  stops; releasing anywhere commits.
- **Android parity**: same gesture (press → drag → release) via pointer
  input; each stop crossing fires a clock-tick haptic so you can adjust
  eyes-free. Web gets no substitute haptic.
- **Accessibility**: the brain is `role="slider"` (min/max = supported stop
  indices, `aria-valuetext` = canonical name). Keyboard: focus it and
  ArrowLeft/ArrowRight steps levels, Home/End to the extremes — same commit
  path as the gesture.
- Model without `reasoning` → press shows a brief toast, "this model
  doesn't do thinking", and no slider.

---

## 4. Model popup

Bottom sheet on web (same sheet chrome as the tree drawer, so it feels like
one family; on phones it docks above the status bar), **not** a modal over
the whole screen. Content:

```
 Model                                    ✕
 ────────────────────────────────────────
 ✓ Claude Opus 4.8        anthropic · 1M
   Claude Sonnet 5        anthropic · 1M
   Claude Haiku 4.5       anthropic · 200k
   GPT-5.2                openai · 400k
   GPT-5.2 Codex          openai · 400k
 ────────────────────────────────────────
 from your pi enabled models · ~/.pi/agent/settings.json
```

- Rows: `Model.name` semibold; right-aligned dim `provider · contextWindow`.
- Current model check-marked; tapping it just closes.
- Group headers only when >6 models: provider name, dim, uppercase-free.
- Selecting sends `set_model`; the popup closes immediately and the bar
  updates when the `status` echo lands (optimistic dim of the name until
  then). If pi rejects ("Model not found" — pattern matched a model without
  auth), a toast explains it and the bar stays as it was.
- Switching model keeps the session (pi does; no history loss).

---

## 5. Protocol (v5)

`packages/protocol/src/index.ts` + Kotlin mirror `Protocol.kt`.

```ts
// ServerEvent additions
| { type: "status"; model: ModelInfo | null; thinkingLevel: string;
    thinkingLevels: string[]; context: ContextInfo | null }
| { type: "model_list"; models: ModelInfo[] }

export type ModelInfo = {
  provider: string; id: string; name: string;
  reasoning: boolean; contextWindow: number;
  thinkingLevelMap: Record<string, string | null>;   // canonical → native
};
export type ContextInfo = { tokens: number | null; contextWindow: number; percent: number | null };

// ClientMessage additions
| { type: "set_model"; provider: string; modelId: string }
| { type: "set_thinking_level"; level: string }
| { type: "list_models" }
```

Notes: `thinkingLevels` is pi's clamped per-model list (the slider's stops
render it verbatim); `status` carries the full snapshot so clients are dumb mirrors;
`model_list` is pushed in reply to `list_models` (broadcast is fine — every
client just keeps the latest).

### Server plumbing (apps/server)

- `RpcAgentDriver` gains `setModel()`, `setThinkingLevel()`, `stats()`,
  `availableModels()` (request/response over the existing JSONL framing) and
  re-polls `get_state` + `get_session_stats` after every successful
  `set_*`, broadcasting `status` through the normal driver-event path.
- Broadcast `status` (a) after driver `ready`, (b) after each
  `agent_settled` (usage only changes when the assistant answers), (c) after
  each `set_*` echo. No timers, no polling loop.
- `list_models` handler: `get_available_models` (cached ~5 min) ∩
  `enabledModels` patterns (SettingsManager + minimatch). Snapshot's
  `model` widens from `"provider/id"` string to `ModelInfo`.
- Secrets: settings read touches only `enabledModels` — never auth-storage;
  nothing provider-key-shaped ever reaches the wire (AGENTS.md rule).

### Clients

- **Web** (`apps/web`): `useAgentStatus` state fed by the two events;
  `StatusBar` + `ModelSheet` + the brain `ThinkingSlider` (one pointer-capture
  code path for mouse/touch/pen); styles via tokens only (`surface`, `line`,
  `text-dim`, `accent`, `danger`). Brain is an inline SVG component (no icon
  dependency).
- **Android**: bottom `Row` above the composer; `ModalBottomSheet`s;
  brain as a two-tone vector drawable; `Protocol.kt` gains the three
  messages + two events with the usual parsing tests.

---

## 6. Tests

- protocol round-trip TS + Kotlin (status snapshot, model_list, new client messages).
- server (mock driver): `status` on hello; after `agent_settled`; `set_thinking_level` echoes updated snapshot; `list_models` applies enabled-pattern filtering incl. `*` glob and `:level` suffix; non-reasoning model → `thinkingLevels: ["off"]`.
- web component smoke: bar renders `—` when `context` null; danger percent ≥ 85; brain alpha per level table above; slider stop-mapping (supported levels distributed evenly, snap + clamp), commit fires exactly on release, tap-without-swipe commits nothing.
- Live gate: against the real omni GLM session — bar shows real context after one exchange; switch omni's model back and forth; press-hold the brain, swipe to a new level, watch the brain relight and confirm pi's next reply runs at that effort.

## 7. Phases

1. Protocol v5 + driver methods + server plumbing + tests.
2. Web status bar (model sheet + thinking slider) + live gate.
3. Android parity + unit tests + emulator check.
4. Docs: ui-prd §7c (status bar grammar), README note (`enabledModels` respected).

## Decisions I made for you (flag any you disagree with)

- **One canonical ladder everywhere** — no per-provider icon variants; native values appear only as a dim suffix in the drag chip when they differ. This is pi's own conversion, per your call.
- **Thinking adjusts via press-hold + swipe slider** (your call) — commits on release, previews brightness while dragging, snaps to supported stops only. No popup exists for thinking anymore.
- **Plain tap on the brain changes nothing** — deliberate anti-footgun: a stray tap while grabbing the mic must not silently wrap `max → off`. (Easy to flip to "tap = +1 step" if you prefer.)
- **No "ultra"** — top of the ladder is `max`; unavailable levels simply never render (pi clamps the list per model).
- **Brain brightness = fill-opacity steps** on one glyph, not seven distinct icons.
- **Context format exactly `used/total (used%)`** with k/m abbreviation; danger tint ≥ 85%.
- **Peers (repo/worktree targets) show no controls** — the gateway has no RPC into pigeon sessions, so model/thinking for peers stays out of scope (say the word if you want `pigeon`-based control later).

---

## As-built deviations

Shipped across `d05d47e` (protocol+server), `71ceb41` (web), `6d66dae`
(android). Everything else built as designed.

- **Android skips provider group headers** in the model sheet (the web
  groups when >6 models). Enabled lists are short; a flat sheet matched the
  platform's sheet idiom better.
- **Chip lingers 1.2s** after commit (design said ~1s) — enough to read
  `off · none` comfortably.
- **`list_models` is requested fresh on every sheet open**; the server
  answers from the driver's 5-minute cache of pi's `get_available_models`,
  so pattern edits in pi settings are picked up without re-auth latency.
- **The enabled-pattern matcher** implements pi's semantics for the listing
  case (exact `provider/id`, bare `id`, or glob over either, `:level`
  suffix stripped) — it does not reproduce pi's alias-over-dated-version
  preference, which only matters when one pattern resolves several models.
- **Commit follows the last previewed stop, never the raw release point**
  (bug found by hand-testing: the brain sits left of the track, so a tap's
  up-x clamps to stop 0 = `off` and would silently commit it; a tap has no
  moves, so committing `preview` makes it a no-op — matching the Android
  gesture, which was already correct).
- Web `setPointerCapture` failures are swallowed (synthetic/inactive pointer
  ids throw); touch pointers capture implicitly, so the gesture is
  unaffected.
