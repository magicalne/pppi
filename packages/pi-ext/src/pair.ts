// Pair-link rendering for /pair: URL + terminal QR.
// QR generation is the vendored qrcode-terminal (MIT, see vendor/).

import { createRequire } from "node:module";
import type { PairFile } from "./store.ts";

const require = createRequire(import.meta.url);

type QrTerminal = { generate(input: string, opts: { small: boolean }): string };

let cached: QrTerminal | null | undefined;

function qrLib(): QrTerminal | null {
	if (cached !== undefined) return cached;
	try {
		cached = require("../vendor/qrcode-terminal/lib/main.js") as QrTerminal;
	} catch {
		cached = null;
	}
	return cached;
}

export function pairUrl(pair: PairFile): string {
	const base = pair.urls[0] ?? `http://localhost:${pair.port}`;
	return `${base}/?pair=${pair.token}`;
}

/** The QR as unicode half-block text, or null when the vendor lib is unavailable. */
export function qrText(pair: PairFile): string | null {
	const lib = qrLib();
	if (!lib) return null;
	try {
		return lib.generate(pairUrl(pair), { small: true });
	} catch {
		return null;
	}
}
