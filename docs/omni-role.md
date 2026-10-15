# The omni role — background coordination (#13)

The omni agent is a **coordinator**: the user's channel must never block on peer work. This page is the contract for delegation and how completed background work catches up with the user. (Task envelope / request-vs-task protocol: #15. Delivery of rich results: artifacts, `docs/artifacts.md`.)

## The pattern: async by default

1. **Send, don't wait.** `omni_send` without `wait` returns a msgId immediately. Tell the user WHO you asked (by profile name — the client renders that agent's reply in its color) and WHAT to expect, then answer them now.
2. **Collect on later turns.** `omni_replies` (one call per turn at most) picks up finished replies. With none in the mailbox, say "still waiting on X" and move on — never stall the turn polling.
3. **Results surface themselves.** When a delegated reply lands in the omni's mailbox while no omni turn is active, the gateway broadcasts a `peer_report` event: the phone shows a tappable notification — "**ppi-dev-1** reported: <first line> … tap to view" — and the full reply drops into the chat (in the agent's color, with any artifacts attached). The user sees finished background work without asking.

## The anti-pattern this replaces

Observed 2026-10-15: the omni delegated a trivial task (create one GitHub issue) with `omni_send(wait=true)` — a blocking pigeon call, up to 120s. During that window the user's messages went unanswered; the phone felt dead mid-conversation ("Hey, I'm still talking").

**Rule:** `wait=true` is allowed ONLY when the user explicitly asks to wait for the result ("wait for it", "stay on this until it's done"). The tool description and the omni system prompt both encode this.

## Why no injection into the running turn

A reply that lands mid-turn is carried by the conversation itself (mailbox poll → chat, in the agent's color); injecting text into an in-flight agent turn would fight pi's own turn lifecycle. The `peer_report` notification covers the complementary case: replies that land while the omni is idle, when nothing else would announce them. The omni still gets the full picture on its next turn via `omni_replies` (the gateway consumes with `--keep`).

## Wire shape

`packages/protocol` (TS) and `apps/android/.../Protocol.kt` stay in sync:

```ts
{ type: "peer_report"; id: string; profileId: string; preview: string }
```

- `id` — matches the `assistant_final` message id of the reply (the client's tap jumps to `#msg-<id>`)
- `profileId` — the reporting agent's session id; the client resolves name/color from its profile cache, falling back to `#<id-prefix>`
- `preview` — first non-empty line of the reply, ≤90 chars
