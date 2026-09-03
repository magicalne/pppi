// Session profiles: identity for pi sessions (name/color/description).
//
// Explicit profiles live at $SSPI_DIR/profiles/<sessionId>.json (written by
// the /profile pi command). Sessions without one get a *derived* profile —
// deterministic name/color from the registry — so attribution coloring works
// before anyone has run /profile. The JSON shape here is the contract the
// pi extension writes; keep the two in sync.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { sspiDir } from "./config.ts";
import type { Profile } from "@sspi/protocol";

export const PROFILE_COLORS = [
	"#e8b14a", // amber
	"#5b8c51", // matcha
	"#7aa2ff", // periwinkle
	"#d96c47", // ember
	"#b48ead", // lilac
	"#4fb0a5", // teal
	"#e05f65", // rose
	"#8fae5b", // moss
	"#c78a4d", // caramel
	"#6f8db9", // steel
] as const;

export function colorForId(sessionId: string): string {
	const hash = createHash("sha1").update(sessionId).digest();
	return PROFILE_COLORS[hash[0]! % PROFILE_COLORS.length]!;
}

export function readProfileFile(sessionId: string, dir: string): Profile | null {
	const p = join(dir, "profiles", `${sessionId}.json`);
	if (!existsSync(p)) return null;
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Profile>;
		if (!raw.name || !raw.color) return null;
		return {
			id: sessionId,
			name: raw.name,
			color: raw.color,
			description: raw.description ?? "",
		};
	} catch {
		return null;
	}
}

/** Explicit profiles for the given session ids, derived ones for the rest. */
export function buildProfiles(
	sessionIds: string[],
	info: { id: string; name?: string | null; cwd?: string }[],
	dir: string = sspiDir(),
): Record<string, Profile> {
	const byId = new Map(info.map((s) => [s.id, s]));
	const out: Record<string, Profile> = {};
	for (const id of sessionIds) {
		const explicit = readProfileFile(id, dir);
		if (explicit) {
			out[id] = explicit;
			continue;
		}
		const s = byId.get(id);
		const fallback =
			s?.name ??
			(s?.cwd ? s.cwd.split("/").filter(Boolean).at(-1) : undefined) ??
			`#${id.slice(0, 4)}`;
		out[id] = {
			id,
			name: fallback,
			color: colorForId(id),
			description: s?.cwd ? `pi session in ${s.cwd}` : "pi session",
		};
	}
	return out;
}

/** All explicitly saved profiles in $SSPI_DIR/profiles (for the pi extension's profiles_list tool). */
export function listExplicitProfiles(dir: string = sspiDir()): Profile[] {
	const d = join(dir, "profiles");
	if (!existsSync(d)) return [];
	const out: Profile[] = [];
	for (const f of readdirSync(d)) {
		if (!f.endsWith(".json")) continue;
		const prof = readProfileFile(f.replace(/\.json$/, ""), dir);
		if (prof) out.push(prof);
	}
	return out;
}
