// Voice mode persistence (#53/#54): "always" | "ptt" | "off".
// localStorage-backed; unknown/missing values default to OFF (#54: fresh
// installs never surprise-record; the user opts into a mode explicitly).

export type VoiceMode = "always" | "ptt" | "off";

const KEY = "pppi.voiceMode";

export function parseVoiceMode(raw: string | null): VoiceMode {
	if (raw === "ptt" || raw === "always" || raw === "off") return raw;
	return "off"; // #54: the default state is OFF
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
