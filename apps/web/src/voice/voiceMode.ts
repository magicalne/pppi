// Voice mode persistence (#53): "always" (always-listen) | "ptt"
// (push-to-talk). "off" + default-off land with #54. localStorage-backed;
// unknown values fall back to "always".

export type VoiceMode = "always" | "ptt";

const KEY = "pppi.voiceMode";

export function parseVoiceMode(raw: string | null): VoiceMode {
	return raw === "ptt" ? "ptt" : "always";
}

export function loadVoiceMode(): VoiceMode {
	try {
		return parseVoiceMode(localStorage.getItem(KEY));
	} catch {
		return "always";
	}
}

export function persistVoiceMode(mode: VoiceMode): void {
	try {
		localStorage.setItem(KEY, mode);
	} catch {
		// private mode etc. — the in-memory choice still applies
	}
}
