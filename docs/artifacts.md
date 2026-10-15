# Artifacts — rich views in the phone client (#17)

An **artifact** is a rich, self-contained HTML view an agent delivers inside an ordinary reply — dashboards, tables, charts, long structured reports. The phone renders it as a tappable card that opens a full-screen view, instead of a wall of markdown.

Cross-links: #16 (markdown stays the chat lane), #15 (long jobs run as tasks; a task deliverable that meets the criteria below should come back as an artifact). Part 1 — the agent-side skill that *decides* — lands after this envelope.

## How an agent emits one

Write a fenced code block with the `pppi-artifact` info string anywhere in a reply:

````markdown
Here's the fleet overview:

```pppi-artifact title="Fleet status"
<!doctype html>
<html>…fully self-contained document…</html>
```
````

- `title="…"` — shown on the card and the full-screen header (quoted or bare word; default "Untitled artifact").
- `kind=html` is the default and the only kind today; `svg`/`mermaid` are planned. An unknown kind is left as a plain code block — old clients degrade safely.
- Longer fences (4+ backticks) work if the artifact itself contains ``` lines.
- The fence is invisible machinery: the **gateway** peels it out of the chat text (client sees clean markdown + an artifact payload), ids are content-hashed so reconnects/history pages render the same card, and voice already skips code fences so artifacts are never spoken.

## When to emit an artifact vs markdown (agent guidance)

| Deliverable | Lane |
| --- | --- |
| Tabular/comparative data, dashboards, metrics | **artifact** |
| Multi-section long reports with structure (TOC, styled sections) | **artifact** |
| Visual content — charts, diagrams, timelines | **artifact** |
| Short conversational answers, quick facts, code snippets | **markdown** (chat) |
| Mixed | markdown summary in chat + artifact for the rich body |

Rules of thumb: if it would be a `docs/…` page or a slide, artifact; if it fits in three sentences or one code block, markdown. Artifacts must be **self-contained** — inline styles only, no external scripts/images/fonts (the sandbox blocks network anyway).

## Client security model (deliberate, documented)

The artifact renders in an `<iframe srcdoc>` with:

- `sandbox="allow-scripts"` **without** `allow-same-origin` → the iframe gets an **opaque origin**. It cannot read the client's localStorage (the pairing token), cookies, or parent DOM; no popups, no forms, no top-level navigation. Scripts run (interactive artifacts later) but isolated.
- A CSP meta injected as the *first* thing in the srcdoc: `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:` → **zero network**: no fetch/XHR/websockets, no external images/fonts/scripts. An artifact cannot phone home or probe the LAN.
- `referrerPolicy="no-referrer"`.

In short: an artifact is a sealed document — styling and inline scripts allowed, everything else denied. See `apps/web/src/Artifact.tsx` and the tests in `apps/web/test/artifact.test.ts` (which pin the sandbox/CSP constants).

## One-tap QA

Open the client with `?demo-artifact` (e.g. `http://mac:8787/?demo-artifact`) — a local demo message with the fixture artifact appears; tap the card to see the full-screen sandboxed view. The fixture lives at `docs/fixtures/demo-artifact.html` (single source: the web demo and gateway tests both use it).

## Wire shape

`packages/protocol` (TS) and `apps/android/.../Protocol.kt` stay in sync:

```ts
type Artifact = { id: string; title: string; kind: "html"; content: string };
// ChatEntry.artifacts?: Artifact[]; assistant_final.artifacts?: Artifact[]
```

Extraction happens at every gateway boundary where text goes out to clients (`assistant_final`, delegated replies, `hello_ok` history, `history_page`) — stored text (pi's session, peerLog) stays raw, so extraction is idempotent across reconnects.
