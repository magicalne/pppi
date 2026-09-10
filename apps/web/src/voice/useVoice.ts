// React glue for interactive mode. Owns the mic, the websocket and the
// player, and exposes one UI-facing state machine with two layers:
//   boot:   off → connecting → warming? → (ready: boot = null)
//   live:   listening ⇄ speaking(user) → thinking → agent-speaking → listening
// Failures land back in "off" with a notice (tap ● to retry); a mid-session
// drop auto-reconnects twice before giving up. Barge-in is server-decided
// (it knows TTS state); the client just stops playback the moment `vad
// speaking` arrives while the agent is talking.

import { useCallback, useRef, useState } from "react";
import { type VoiceBootFrame, VoiceClient } from "./client.ts";
import { MicStream } from "./mic.ts";
import { TtsPlayer } from "./playback.ts";

export type VoicePhase = "listening" | "user-speaking" | "thinking" | "agent-speaking";
export type VoiceBoot = "connecting" | "warming" | "reconnecting";

export type VoiceSessionState = {
	phase: VoicePhase;
	committed: string;
	tentative: string;
	notice: string | null;
	/** null = not started or fully ready; otherwise the pill shows boot progress. */
	boot: VoiceBoot | null;
	bootDetail: string | null;
	/** VAD hears speech but STT has produced no text for a while — show it honestly. */
	stalled: boolean;
};

/** 0-100 peak level of an s16le chunk — feeds the soundwave. */
function peak16(pcm: ArrayBuffer): number {
	const view = new Int16Array(pcm);
	let max = 0;
	for (let i = 0; i < view.length; i++) {
		const v = Math.abs(view[i] ?? 0);
		if (v > max) max = v;
	}
	return Math.min(100, (max * 95) / 32767);
}

function peakFloat(pcm: Float32Array): number {
	let max = 0;
	for (let i = 0; i < pcm.length; i++) {
		const v = Math.abs(pcm[i] ?? 0);
		if (v > max) max = v;
	}
	// float −1…1; mirrors the s16le scaling (0.1 amplitude → ~9.5 on both)
	return Math.min(100, max * 95);
}

const BOOT_COMPONENT: Record<string, string> = {
	stt: "the speech model",
	tts: "the agent's voice",
	vad: "the ear model",
};

const WARMING_CAP_MS = 90_000;

export function useVoice() {
	const [on, setOn] = useState(false);
	const [state, setState] = useState<VoiceSessionState>({
		phase: "listening",
		committed: "",
		tentative: "",
		notice: null,
		boot: null,
		bootDetail: null,
		stalled: false,
	});
	const [levels, setLevels] = useState({ mic: 0, out: 0 });
	const refs = useRef({
		mic: null as MicStream | null,
		client: null as VoiceClient | null,
		player: null as TtsPlayer | null,
		phase: "listening" as VoicePhase,
		ttsRate: 24000,
		attempts: 0,
		lastStart: null as { base: string; token: string } | null,
		levelAt: { mic: 0, out: 0 },
		startFn: null as ((base: string, token: string, reconnect?: boolean) => Promise<void>) | null,
		// stall watchdog inputs: last time VAD opened the turn / STT showed text
		speakingSince: 0,
		lastPartialAt: 0,
		stalled: false,
	});

	const setPhase = useCallback((phase: VoicePhase) => {
		refs.current.phase = phase;
		setState((s) => ({ ...s, phase }));
	}, []);

	const setBoot = useCallback((boot: VoiceBoot | null, bootDetail: string | null = null) => {
		setState((s) => ({ ...s, boot, bootDetail }));
	}, []);

	const stop = useCallback(async () => {
		const { mic, client, player } = refs.current;
		refs.current.client = null;
		refs.current.mic = null;
		refs.current.player = null;
		refs.current.lastStart = null;
		refs.current.speakingSince = 0;
		refs.current.lastPartialAt = 0;
		refs.current.stalled = false;
		client?.close();
		await mic?.stop().catch(() => {});
		await player?.close().catch(() => {});
		setOn(false);
		setLevels({ mic: 0, out: 0 });
		setState({
			phase: "listening",
			committed: "",
			tentative: "",
			notice: null,
			boot: null,
			bootDetail: null,
			stalled: false,
		});
	}, []);

	const start = useCallback(
		async (base: string, token: string, reconnect = false) => {
			const r = refs.current;
			if (r.client) return;
			r.lastStart = { base, token };
			setState((s) => ({
				...s,
				boot: reconnect ? "reconnecting" : "connecting",
				bootDetail: null,
				notice: null,
			}));
			const mic = new MicStream();
			const player = new TtsPlayer();
			const client = new VoiceClient(base, token, {
				onState: (s) => {
					if (s === "thinking") setPhase("thinking");
					else if (s === "speaking") setPhase("agent-speaking");
					else if (s === "listening" && refs.current.phase !== "user-speaking") setPhase("listening");
				},
				onVad: (speaking) => {
					if (speaking) {
						// the user's voice wins instantly: drop agent audio
						player.stopAll();
						refs.current.speakingSince = Date.now();
						refs.current.stalled = false;
						setState((s) => ({ ...s, tentative: "", committed: "", stalled: false }));
						setPhase("user-speaking");
					} else {
						refs.current.speakingSince = 0;
						refs.current.stalled = false;
						setState((s) => ({ ...s, stalled: false }));
						if (refs.current.phase === "user-speaking") setPhase("listening");
					}
				},
				onPartial: (committed, tentative) => {
					if (committed || tentative) {
						refs.current.lastPartialAt = Date.now();
						if (refs.current.stalled) {
							refs.current.stalled = false;
							setState((s) => ({ ...s, committed, tentative, stalled: false }));
							return;
						}
					}
					setState((s) => ({ ...s, committed, tentative }));
				},
				onFinal: (text) => setState((s) => ({ ...s, committed: text, tentative: "" })),
				onTtsStart: (rate) => {
					refs.current.ttsRate = rate;
					setPhase("agent-speaking");
				},
				onTtsChunk: (pcm) => {
					player.play(pcm, refs.current.ttsRate);
					const now = Date.now();
					if (now - refs.current.levelAt.out >= 80) {
						refs.current.levelAt.out = now;
						setLevels((l) => ({ ...l, out: peak16(pcm) }));
					}
				},
				onTtsEnd: (interrupted) => {
					setPhase("listening");
					if (interrupted) setState((s) => ({ ...s, notice: "interrupted" }));
					setLevels((l) => ({ ...l, out: 0 }));
					// speaker drained locally — tell the server so echo-aware
					// barge-in thresholds can relax
					void player.waitIdle().then(() => refs.current.client?.playbackDone());
				},
				onError: (message) => setState((s) => ({ ...s, notice: message })),
				onBoot: (frame: VoiceBootFrame) => {
					if (frame.stage === "ready") return; // one component done; hello is next
					if (frame.stage === "failed") {
						setBoot("warming", frame.reason ?? "the Mac's voice models aren't ready");
						return;
					}
					setBoot("warming", `loading ${BOOT_COMPONENT[frame.component ?? ""] ?? "the voice models"}…`);
				},
				onGone: () => {
					// stop() nulls the refs first, so a live client here = the drop
					// was not user-initiated → auto-reconnect twice, then give up
					if (refs.current.client !== client) return;
					const attempts = ++refs.current.attempts;
					void stop();
					if (attempts <= 2 && refs.current.lastStart) {
						setBoot("reconnecting");
						const { base: b, token: t } = refs.current.lastStart;
						setTimeout(() => void refs.current.startFn?.(b, t, true), 2000);
					} else {
						refs.current.attempts = 0;
						setState((s) => ({ ...s, notice: "voice dropped — tap ● to start again" }));
					}
				},
			});
			refs.current.mic = mic;
			refs.current.player = player;
			refs.current.client = client;
			// warming watcher: after 3 s of silence, poll /api/health so the pill
			// can tell "slow network" from "the Mac is loading its models" — and
			// cap the wait so nobody stares at a spinner forever
			const bornAt = Date.now();
			const poll = setInterval(() => {
				if (refs.current.client !== client || client.active) {
					clearInterval(poll);
					return;
				}
				if (Date.now() - bornAt > WARMING_CAP_MS) {
					clearInterval(poll);
					client.close();
					refs.current.client = null;
					refs.current.mic = null;
					refs.current.player = null;
					void mic.stop().catch(() => {});
					setBoot(null);
					setState((s) => ({
						...s,
						notice: "the Mac is still warming up — give it a minute, then tap ● again",
					}));
					return;
				}
				fetch(`${base.replace(/\/$/, "")}/api/health`)
					.then((res) => res.json())
					.then((h: { boot?: { stage?: string }; stt?: { ready?: boolean; reason?: string } }) => {
						if (refs.current.client !== client || client.active) return;
						if (h.boot?.stage === "starting") setBoot("warming", "waking the voice service…");
						else if (h.stt && h.stt.ready === false) setBoot("warming", humanSttReason(h.stt.reason));
						else if (Date.now() - bornAt > 3000) setBoot("warming", "reaching the Mac…");
					})
					.catch(() => {
						if (refs.current.client === client && !client.active && Date.now() - bornAt > 3000)
							setBoot("warming", "reaching the Mac…");
					});
			}, 2000);
			try {
				await client.start(mic);
				clearInterval(poll);
				refs.current.attempts = 0;
				await mic.start((pcm) => {
					client.sendAudio(pcm);
					const now = Date.now();
					if (now - refs.current.levelAt.mic >= 80) {
						refs.current.levelAt.mic = now;
						setLevels((l) => ({ ...l, mic: peakFloat(pcm) }));
					}
					// stall watchdog: VAD opened a turn but STT went quiet — say so
					// instead of an eternal "…" (the server falls back to batch on
					// its side; this line tells the human what's happening)
					if (
						refs.current.phase === "user-speaking" &&
						!refs.current.stalled &&
						now - Math.max(refs.current.lastPartialAt, refs.current.speakingSince) > 5000
					) {
						refs.current.stalled = true;
						setState((s) => ({ ...s, stalled: true }));
					}
				});
				setOn(true);
				setBoot(null);
				setState({
					phase: "listening",
					committed: "",
					tentative: "",
					notice: null,
					boot: null,
					bootDetail: null,
					stalled: false,
				});
			} catch (err) {
				clearInterval(poll);
				refs.current.client = null;
				refs.current.mic = null;
				refs.current.player = null;
				refs.current.lastStart = null;
				client.close();
				await mic.stop().catch(() => {});
				setBoot(null);
				const why = err instanceof Error ? err.message : "microphone unavailable";
				setState((s) => ({ ...s, notice: `couldn't start voice: ${why} — tap ● to retry` }));
			}
		},
		[setBoot, setPhase, stop],
	);

	refs.current.startFn = start;

	const interrupt = useCallback(() => {
		refs.current.player?.stopAll();
		refs.current.client?.interrupt();
		setPhase("listening");
	}, [setPhase]);

	const clearNotice = useCallback(() => setState((s) => ({ ...s, notice: null })), []);

	return { on, state, levels, start, stop, interrupt, clearNotice };
}

function humanSttReason(reason?: string): string {
	if (!reason) return "the Mac's speech model isn't ready";
	// the gateway's "no local STT model" reason is a whole install recipe —
	// keep the pill human and short
	if (reason.includes("no local STT model")) return "the Mac has no speech model yet — run /transcribe once in pi";
	return reason.length > 80 ? `${reason.slice(0, 77)}…` : reason;
}
