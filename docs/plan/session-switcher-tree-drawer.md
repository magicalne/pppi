# Plan — Target switcher as an indented tree drawer

**Date:** 2026-09-03 · **Status:** folded into the V1 plan as Phase 0 — see [v1-full-picture.md](./v1-full-picture.md). Implementation paused pending approval of that plan.
**Scope:** UI-only redesign of the session/target switcher on web + Android.

## Feedback being addressed

Tapping the target name ("Omni ⌄") in the presence bar should reveal a
**list of lists spread out with indentation** — Omni → project → worktrees.
The current design is a bottom sheet with "Show projects"/"Show worktrees"
visibility toggles: wrong shape, and hiding the tree by default is wrong.

Accepted presentations given by the user:

1. a popup in the middle, or
2. **a drawer dropping from the Omni pill, drawn in front of the chat
   history** ← chosen (it keeps the anchor point where the tap happened and
   leaves the conversation visible under a scrim).

## Chosen design

```
Tapping the presence bar opens, anchored just below it:

╭────────────────────────────────╮
│ SESSIONS                       │
│ ◉ Omni              the fleet  │   depth 0
│ │ ◉ ss              working…   │   depth 1 = repo (= its main session)
│ │ │ ◉ wt/fix-auth   idle       │   depth 2 = worktrees
│ │ │ ◉ wt/perf       reading…   │
│ │ ◉ pigeon           idle      │
│ │ ◉ notes — no open session   │   dim, not tappable
│ │ ◉ spike          idle       │   depth 1 = non-repo "others"
│ ────────────────────────────── │
│ Unpair this device             │
╰────────────────────────────────╯
  (scrim over the chat; tap anywhere outside closes)
```

Rules:

- **Always expanded.** The visibility toggles and their `pppi.projects` /
  `pppi.worktrees` localStorage keys are deleted. Omni is always the first row.
- A repo row **is** its main session (label = bare repo name — the `· main`
  suffix is dropped). Worktrees indent one level under it as `wt/<name>`.
  A repo with no open session renders a dim, non-tappable row.
- Faint **vertical guide lines** per ancestor level make the indentation
  legible (file-tree style).
- Each row keeps its own one-line state (existing grammar: `idle` /
  `working…` / `unreachable`); the active row keeps the accent bar + surface
  tint. Picking a row switches the transcript and closes the drawer.
- **Unpair this device** stays as the drawer footer (both platforms) — e2e's
  unpair phase depends on this copy.

Implementation shape:

- **Web:** header + drawer wrapped in a `position: relative` headwrap; drawer
  is `position: absolute; top: 100%` under the bar, `min(340px, 100vw-24)`
  wide, scrollable, z-index above the list; existing `.backdrop` reused.
- **Android:** replace `ModalBottomSheet` with a root-level overlay: full-size
  scrim `Box` (tap closes) + a `Column` panel padded to sit directly below the
  presence bar (bar height captured via `onGloballyPositioned`), rounded,
  bordered, scrollable. `TreeRow` composable renders one guide `Box` per depth
  level (`Row(IntrinsicSize.Min)` so guides span the row height).

## Changes

| File | Change |
|---|---|
| `apps/web/src/App.tsx` | `SessionSheet` → `SessionDrawer` (tree, no toggle props); drop `showProjects`/`showWorktrees` state + localStorage keys. **Already half-done** — see Current state. |
| `apps/web/src/styles.css` | remove `.sheet` internals, `.toggle-row`, `.switch`; add `.headwrap`, `.drawer`, `.srow .guide` tree styles |
| `apps/android/.../MainActivity.kt` | replace the `ModalBottomSheet` block with scrim + panel overlay + `TreeRow`; remove `showProjects`/`showWorktrees` state and now-unused `Switch`/`ModalBottomSheet` imports |
| `docs/design/ui-prd.md` | §2 diagram + §3 note (tap opens drawer), §4 rewritten as tree drawer, §12 Android parity wording, decision table D5 (bottom sheet → **tree drawer from the target pill**) and D6 (hidden by default → **always expanded**) |

**Out of scope:** the multi-machine work (menu button left of Omni,
connections list, `/omni` `/pair` `/profile` extensions). That gets its own
plan when green-lit. Nothing in this change touches protocol, gateway, or tests.

## Verification

1. **Web:** `bun run build` (typecheck) in `apps/web`; screenshot the drawer
   open in Dusk at `localhost:8787`; pick a repo row → presence bar shows the
   repo + composer placeholder changes; pick Omni → back.
2. **Android:** assemble + install on the running emulator; screenshot the
   drawer; run instrumented tests (`connectedDebugAndroidTest`, expect 11/11 —
   none reference the sheet).
3. **e2e:** `apps/android/e2e/run.sh` expect 17/17 (no copy it depends on
   changes; unpair stays).

## Current state (honest)

`App.tsx` is mid-refactor: state renamed `sheetOpen` → `drawerOpen`, header
wrapped in `.headwrap`, and the drawer JSX now references a `SessionDrawer`
component that **does not exist yet** — the web app does not compile at this
moment. Execution order: finish `SessionDrawer` → web CSS → Android → PRD →
verify all three.
