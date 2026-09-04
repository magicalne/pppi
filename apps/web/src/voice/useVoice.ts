// React glue for interactive mode: owns the mic, the websocket and the
// player, and exposes one UI-facing state machine —
//   off → listening ⇄ speaking(user) → thinking → agent-speaking → listening
// Barge-in is server-decided (it knows TTS state); the client just stops
// playback the moment `vad speaking` arrives while the agent is talking.

import { useCallback, useRef, useState } from "react";
import { VoiceClient } from "./client.ts";
import { MicStream } from "./mic.ts";
import { TtsPlayer } from "./playback.ts";

export type VoicePhase = "listening" | "user-speaking" | "thinking" | "agent-speaking";

export type VoiceSessionState = {
	phase: VoicePhase;
	committed: string;
	tentative: string;
	notice: string | null;
};

export function useVoice() {
	const [on, setOn] = useState(false);
	const [state, setState] = useState<VoiceSessionState>({
		phase: "listening",
		committed: "",
		tentative: "",
		notice: null,
	});
	const refs = useRef({
		mic: null as MicStream | null,
		client: null as VoiceClient | null,
		player: null as TtsPlayer | null,
		phase: "listening" as VoicePhase,
		ttsRate: 24000,
	});

	const setPhase = useCallback((phase: VoicePhase) => {
		refs.current.phase = phase;
		setState((s) => ({ ...s, phase }));
	}, []);

	const stop = useCallback(async () => {
		const { mic, client, player } = refs.current;
		refs.current.client = null;
		refs.current.mic = null;
		refs.current.player = null;
		client?.close();
		await mic?.stop().catch(() => {});
		await player?.close().catch(() => {});
		setOn(false);
		setState({ phase: "listening", committed: "", tentative: "", notice: null });
	}, []);

	const start = useCallback(
		async (base: string, token: string) => {
			if (refs.current.client) return;
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
						setState((s) => ({ ...s, tentative: "", committed: "" }));
						setPhase("user-speaking");
					} else if (refs.current.phase === "user-speaking") {
						setPhase("listening");
					}
				},
				onPartial: (committed, tentative) => setState((s) => ({ ...s, committed, tentative })),
				onFinal: (text) => setState((s) => ({ ...s, committed: text, tentative: "" })),
				onTtsStart: (rate) => {
					refs.current.ttsRate = rate;
					setPhase("agent-speaking");
				},
				onTtsChunk: (pcm) => player.play(pcm, refs.current.ttsRate),
				onTtsEnd: (interrupted) => {
					setPhase("listening");
					if (interrupted) setState((s) => ({ ...s, notice: "interrupted" }));
					// speaker drained locally — tell the server so echo-aware
					// barge-in thresholds can relax
					void player.waitIdle().then(() => client.playbackDone());
				},
				onError: (message) => setState((s) => ({ ...s, notice: message })),
				onGone: () => {
					void stop();
					setState((s) => ({ ...s, notice: "voice session ended" }));
				},
			});
			refs.current.mic = mic;
			refs.current.player = player;
			refs.current.client = client;
			try {
				await client.start(mic);
				await mic.start((pcm) => client.sendAudio(pcm));
				setOn(true);
				setState({ phase: "listening", committed: "", tentative: "", notice: null });
			} catch (err) {
				refs.current.client = null;
				refs.current.mic = null;
				refs.current.player = null;
				await client.close().catch(() => {});
				await mic.stop().catch(() => {});
				throw err;
			}
		},
		[setPhase, stop],
	);

	const interrupt = useCallback(() => {
		refs.current.player?.stopAll();
		refs.current.client?.interrupt();
		setPhase("listening");
	}, [setPhase]);

	const clearNotice = useCallback(() => setState((s) => ({ ...s, notice: null })), []);

	return { on, state, start, stop, interrupt, clearNotice };
}
