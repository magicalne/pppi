// The voice pipeline's diary: ~/.pppi/logs/audio.log — a file, not pi's TUI:
// the pane is a conversation, not a log viewer. Rotation keeps it bounded;
// logging never takes voice down. Both hosts write here directly (the cli
// host in-process, the audio child for engine/boot failures) and audio-proxy
// files the child's stderr through the same seam. PPPI_DIR-aware so tests
// can capture output.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { pppiDir } from "./config.ts";

const LOG_MAX_BYTES = 5_000_000;

function logPath(): string {
	return join(pppiDir(), "logs", "audio.log");
}

/** Best-effort timestamped line into audio.log; never throws. */
export function audioLog(line: string): void {
	try {
		const p = logPath();
		mkdirSync(join(p, ".."), { recursive: true });
		if (existsSync(p) && statSync(p).size > LOG_MAX_BYTES) renameSync(p, `${p}.1`);
		appendFileSync(p, `${new Date().toISOString().slice(11, 23)} ${line}\n`);
	} catch {
		// best-effort
	}
}
