# Plan — Interactive mode (hands-free voice conversation)

**Date:** 2026-09-04 · **Status:** implemented (phases 0–4 committed, live-verified). See deviations below.
**Scope:** a full-duplex voice mode: talk to the omni (or any target) continuously — no button to hold, agent answers out loud, either side can interrupt. Web first, Android after web is verified live.

## As-built deviations (agreed during implementation)

1. **VAD runs server-side, in its own host process** (`vadProcess.ts`) —
   not in the browser. Sharing native ONNX state between silero and the
   kokoro/transformers.js stack deadlocked inference (worker threads did not
   help); a child process also fixes event-loop jank from synthesis. LAN
   round-trip (~15 ms) keeps barge-in effectively instant, and the server
   knowing TTS state makes the echo-aware thresholds exact. Clients stream
   PCM continuously and react to `vad` events; `speech_start/end` client
   messages were replaced by this.
2. **playback_done** (client → server): the echo-aware window now tracks
   the client's *audible playback* (it sends `playback_done` when its
   speaker drains), not server synthesis time.
3. **Streaming STT** uses parakeet-unified's published buffered-streaming
   operating point (L=5600, C=560, R=560 ms): live committed text ~1.6 s
   into an utterance, full-accuracy finals.
4. **Web mic tap toggles the interactive session** (hold-to-talk remains
   the fallback whenever the session is off; on Android the press-and-hold
   button is untouched beside it).
5. Keywords act as server-side control phrases on the finalized text
   ("stop", "cancel", …) — never turn-enders.

## The feature

Today voice is hold-to-talk: press, speak, release, wait, read the reply.
Interactive mode turns the same conversation into talking to a person:

- The mic stays live for the session; the user just talks.
- Live captions show what's being heard while speaking (streaming STT partials).
- When the user stops, the agent answers **out loud** (local TTS) while the
  text renders as usual.
- **Barge-in:** talking over the agent stops it instantly; the interruption
  becomes the next turn. Full duplex with echo-aware thresholds.

This is a turn-taking system, not a button change. The deliverable is a
client-side endpointing/barge-in state machine plus a server-side streaming
voice pipeline, wrapped in a visible state machine the UI can render
(`listening → user-speaking → thinking → speaking`).

## Agreed decisions (user-approved in discussion)

| # | Decision |
|---|---|
| D1 | **Silence-based endpointing** on the client (silero VAD + tuned silence timeout + grace period). Keywords are *not* turn-enders; they become mid-stream control commands ("stop", "cancel") detected in live partial text. |
| D2 | **Streaming STT** via the already-installed `transcribe-cpp@0.2.2` `Session.stream()` API — the model we already ship (`parakeet-unified-en-0.6b`) is streaming-capable (rank 1 in pi-transcribe's catalog; 9 streaming models exist). Committed/tentative partial captions. |
| D3 | **TTS behind an abstract provider layer; Kokoro first, switchable.** Local only. `macos-say` implemented as the built-in fallback provider (mirrors `stt.ts` model resolution). |
| D4 | **Full-duplex barge-in** with echo-aware thresholds; cut-off agent answers are discarded ("if it didn't finish saying it, it never said it"). |
| D5 | **Web first**, live-verified end to end, **then Android** in the same plan. |
| D6 | Live partial captions ship in v1 (free once D2 is in). |

Standing constraints that already apply: local STT/TTS only, secrets stay on
the Mac, voice-first grammar, PRD themes/tokens for any new UI, TS + Kotlin
protocol stay in sync.

## Architecture

```
CLIENT (web, then Android)                    SERVER (Mac gateway)
┌────────────────────────────┐                ┌──────────────────────────────────┐
│ mic capture (16k mono PCM16)│                │ /voice WS (token auth, per conn) │
│  → platform AEC/NS/AGC      │   binary PCM   │  VoiceSession (one per WS)       │
│  → silero VAD (ONNX)        │  100 ms chunks │   ├ utterance assembly + pre-roll│
│  → endpointing state machine│ ─────────────▶ │   ├ transcribe-cpp Stream        │
│    (speech_start/end events)│  JSON control  │   │  (parakeet streaming)        │
│                             │                │   ├ keyword commands on partials │
│ TTS playback queue          │  binary audio  │   ├ submitUserText → pi driver   │
│  (WebAudio / AudioTrack)    │ ◀───────────── │   ├ sentence chunker on deltas   │
│  barge-in: VAD during       │  JSON events   │   ├ TtsProvider (kokoro|say)     │
│   playback ⇒ stop + interrupt│               │   └ interrupt ⇒ abort + drain    │
└────────────────────────────┘                └──────────────────────────────────┘
```

- **A dedicated `/voice` WebSocket** (same pairing token, same auth pattern as
  the chat WS), so a voice hiccup can never kill the conversation WS.
- **Client owns capture + VAD + endpointing + playback + barge-in detection**
  (all decisions that must be instant/local). **Server owns STT, agent, TTS**
  (everything that needs the models).
- One VAD instance serves both directions: it gates utterances and, running
  during TTS playback, triggers barge-in.
- The voice session targets **the current conversation target** (omni by
  default) — identical routing to text chat.

### Endpointing timings (client, tunable constants)

| Constant | Value | Why |
|---|---|---|
| pre-roll | 300 ms | word onsets aren't clipped when VAD fires |
| silence endpoint | 650 ms | 400 ms sends on thinker pauses; 1 s feels laggy |
| grace period | 400 ms | don't dispatch until it passes; speech resumes ⇒ same utterance |
| min utterance | 300 ms | coughs/keyboard ≠ turns |
| max utterance | 20 s | force a break |
| VAD suppression after TTS start | 200 ms | speaker attack transients |
| barge-in speech threshold | >300 ms speech | echo/noise resilience while agent talks |

### Protocol additions (`packages/protocol`, mirrored in `Protocol.kt`)

Client → server on `/voice` (JSON text frames):

```ts
{ type: "speech_start" }                  // VAD fired; binary PCM frames follow
{ type: "speech_end" }                    // endpoint decided (post-grace)
{ type: "interrupt" }                     // user talked over the agent
{ type: "state"; state: VoiceClientState } // optional: client-side state for debugging
```

Binary frames: raw PCM16 16 kHz mono chunks (~100 ms), only while an utterance
is open (plus pre-roll).

Server → client:

```ts
{ type: "voice_state"; state: "listening" | "thinking" | "speaking" }
{ type: "stt_partial"; committed: string; tentative: string }
{ type: "stt_final"; text: string }        // also lands as a normal user bubble
{ type: "tts_start"; id: string; rate: number }
// binary frames: s16le PCM at `rate`
{ type: "tts_end"; id: string; interrupted?: boolean }
{ type: "voice_error"; message: string }
```

Voice turns render as ordinary chat bubbles (user caption + assistant answer),
so history, reload, and reconnect keep working unchanged.

## Design details

**Streaming STT (server).** `stt.ts` gains a `StreamingStt` wrapper: one
transcribe-cpp `Session.stream()` per utterance — open on `speech_start`, feed
chunks, relay `committed`/`tentative` as `stt_partial` on each feed,
`finalize()` on `speech_end` (tens of ms — no full re-decode). If the loaded
model reports `supportsStreaming: false`, fall back to batch
`transcribe()` at `speech_end` (feature degrades, pipeline unchanged).

**Keyword commands.** Server checks finalized committed text (and strong
tentative hits) for control phrases — `stop` / `cancel` / `never mind` — and
acts immediately (abort agent / discard utterance) without dispatching to pi.
Endpointing stays silence-owned; keywords only ever *cancel*.

**TTS provider layer (server, `tts.ts`).**

```ts
interface TtsProvider {
	readonly id: "kokoro" | "macos-say";
	readonly status: { ready: true; voice: string } | { ready: false; reason: string };
	/** Synthesize one prose chunk into s16le PCM at its native rate. */
	synthesize(text: string, opts?: { voice?: string }): AsyncIterable<TtsChunk>;
}
```

- `KokoroProvider` — kokoro-82M ONNX. Model resolution mirrors `stt.ts`:
  `PPPI_TTS_MODEL` → known HF-cache kokoro dir → not ready. Runs on
  `onnxruntime-node`, faster than real-time on M-series.
- `MacosSayProvider` — `say --data-format` to WAV, split and streamed; zero
  deps, always available on the Mac.
- Resolution: `PPPI_TTS_PROVIDER` (`kokoro` | `macos-say` | `auto`); auto =
  kokoro if its model is present, else say. Switching providers (or adding
  one) touches exactly one class + one line in the resolver.
- **Sentence chunker:** as `assistant_delta` accumulates, cut at sentence
  boundaries (min length guard), synthesize per sentence, stream chunks out —
  first audio ~1–2 s after pi starts replying. Later sentences render while
  earlier ones play.
- **Speak-prose transform** (before synthesis): strip fenced code →
  "(code on screen)" phrasing, collapse long paths/URLs. Full answer still
  renders as a normal bubble; TTS speaks only prose. This is a coding agent —
  spoken code is garbage.

**Echo/noise (layered, all local).** (1) platform DSP: web
`getUserMedia({ echoCancellation, noiseSuppression, autoGainControl })`,
Android `AcousticEchoCanceler`/`NoiseSuppressor`/`AutomaticGainControl` on the
existing `AudioRecord`; (2) silero VAD as the "is a human talking" gate —
non-speech noise never becomes a turn; (3) echo-aware barge-in thresholds
(suppression window + 300 ms rule) so the agent doesn't hear itself;
headphones dodge AEC entirely. RNNoise is deliberately **not** v1 (park lot);
if added later, denoised audio feeds the VAD, original audio feeds STT.

**Barge-in flow.** VAD speech (>300 ms) during playback ⇒ client stops
playback (100 ms fade) + sends `interrupt` ⇒ server drains TTS queue, calls
the existing `driver.abort()`, marks the cut bubble `interrupted`, discards
the cut answer from context. The interrupting speech was already captured —
it flows through the normal utterance path as the next turn. Same flow
applies while the agent is mid-tools (abort-and-supersede; the tool stream
stays visible on screen).

**State machine (client; server mirrors `voice_state`).**
`idle → listening ⇄ user-speaking → thinking → speaking → listening`, plus
`speaking →(barge-in)→ user-speaking`, errors → `listening` + notice,
5 min idle → paused (tap to resume). The mic pill becomes the state indicator
using the PRD live-status grammar ("talk to a person"). Hold-to-talk remains,
untouched, as the fallback when interactive mode is off; toggling the mode is
one tap on the mic pill.

## Phases

Gate between Phase 3 and Phase 4: **web must be live-verified end to end
(real mic, real model, barge-in exercised) before Android starts.**

### Phase 0 — Protocol + server voice plumbing

| File | Change |
|---|---|
| `packages/protocol/src/index.ts` | `VoiceClientState`, voice message types above |
| `apps/server/src/server.ts` | `/voice` WS route (token auth mirroring chat WS), `VoiceSession` scaffolding, framing (JSON text frames vs binary PCM), `voice_state` mirrored to the chat WS so UIs can show the mode |
| `apps/server/test/server.test.ts` | voice WS auth (401 path), framing, state broadcast with a fake driver |

### Phase 1 — Server streaming STT

| File | Change |
|---|---|
| `apps/server/src/stt.ts` | `StreamingStt` (`Session.stream()` wrapper: open/feed/partial/finalize/dispose; `supportsStreaming` check with batch fallback) |
| `apps/server/src/voice.ts` | utterance assembly: pre-roll, min/max, `stt_partial`/`stt_final`, keyword commands |
| `apps/server/test/*` | fake `StreamingStt` injected: start→pcm→end→final ordering, partial relay, keyword cancel, batch fallback path |

### Phase 2 — TTS provider layer

| File | Change |
|---|---|
| `apps/server/src/tts.ts` | `TtsProvider` interface, `KokoroProvider` (onnxruntime-node; **spike:** `kokoro-onnx` npm vs raw onnxruntime + phonemizer — decision recorded in this doc), `MacosSayProvider`, resolver (`PPPI_TTS_PROVIDER`) |
| `apps/server/src/voice.ts` | sentence chunker over `assistant_delta`, speak-prose transform, TTS queue + drain, `tts_start`/binary/`tts_end`, interrupt wiring to `driver.abort()` |
| `apps/server/test/*` | fake providers: chunking, ordering, drain-on-interrupt, resolution order, say fallback |

### Phase 3 — Web client (gate: live-verified)

| File | Change |
|---|---|
| `apps/web/src/voice/` (new) | mic capture AudioWorklet (16k s16le) + AEC/NS/AGC constraints; silero VAD (onnxruntime-web); endpointing state machine (pure module, table-driven unit tests); `/voice` client; TTS playback queue (WebAudio) |
| `apps/web/src/App.tsx` | mode toggle on the mic pill, state indicator, partial captions (committed solid / tentative dim), interrupted bubble marking, voice_error toasts |
| `apps/web/src/styles.css` | state styles from theme tokens only |
| `apps/web/test/*` | endpointing state machine table tests (synthetic frame sequences), playback queue ordering, barge-in decision logic |

Verification: real-mic live pass — talk, see partials, agent answers aloud,
talk over it, confirm cut-off discard; latency log (endpoint→stt_final→first
TTS chunk) printed by the server.

### Phase 4 — Android client (after web gate passes)

| File | Change |
|---|---|
| `apps/android/.../Protocol.kt` | mirror of all voice messages |
| `apps/android/.../VoiceClient.kt` (new) | OkHttp WS, binary PCM up / audio down |
| `apps/android/.../AudioEngine.kt` (new) | existing `AudioRecord` + platform AEC/NS/AGC, silero VAD (onnxruntime-android), endpointing port of the pure module, `AudioTrack` playback queue, barge-in |
| `apps/android/.../MainActivity.kt` | mode toggle + state pill + captions + interrupted marking (tokens) |
| unit + instrumented tests | endpointing port parity tests, mode UI, playback queue |

Screen-on assumption (app is open) — no foreground service in v1.

### Phase 5 — Polish + docs loop

Idle timeout, reconnect (voice WS drop ⇒ fall back to hold-to-talk + notice),
error paths (TTS unavailable ⇒ text-only + notice; STT garbage ⇒ caption
anyway, correct by text), interrupted-bubble copy, latency numbers in README.
Docs: `README.md` (interactive mode section), `docs/design/ui-prd.md` (§3
live-status states + mic pill states, decision table entry), `AGENTS.md`
(key files: `tts.ts`, `voice.ts`, `apps/web/src/voice/`).

### Loop-back (per working agreement)

After Phase 5, re-walk every phase against this plan: timings re-tuned from
real use, all suites green (TS `bun run test`, Android instrumented), live
verification repeated, judge visual pass on the new states, then commit chain
per phase.

## Latency budget (target)

| Leg | Budget |
|---|---|
| silence endpoint + grace | 650 + 400 ms (feels parallel — captions were live) |
| `finalize()` | ~50 ms |
| pi first sentence | 0.5–2 s |
| TTS first chunk | 0.3–0.8 s |
| **speech-end → first audio** | **~2–3.5 s**, with perceived latency ≈ 0 thanks to live partials |

## Risks & spikes

- **Kokoro on node** (Phase 2 spike): phonemization is the only fiddly part;
  if `kokoro-onnx` npm doesn't hold up, raw onnxruntime + espeak-ng wasm.
  `MacosSayProvider` ships regardless as the always-works fallback.
- **Browser AEC quality** varies; headphones sidestep it, echo-aware
  thresholds degrade gracefully otherwise.
- **silero-on-web port choice** (`@ricky0123/vad-web` vs raw onnxruntime-web)
  — small, isolated, decided in Phase 3.
- **onnxruntime-android** adds ~10–20 MB; acceptable, flagged here.
- Emulator voice e2e stays limited (we know its mic pain); interactive e2e =
  unit/table tests + real-device manual pass.

## Out of scope (park lot, v2+)

Wake word ("hey pi"), semantic endpointing, per-profile TTS voices (Joe sounds
like Joe — natural follow-up now that agents have identities), RNNoise,
bilingual/multilingual STT (streaming models above are EN-only; multilingual =
batch whisper/moonshine-zh swap), multitalker-parakeet + Sortformer
diarization for separating the user from background voices, spoken progress
narration during long tool runs.
