// Profile store rules: the extension side must apply the same validity rule as
// the gateway's readProfileFile (packages/gateway/src/profiles.ts) — a profile
// needs BOTH a name and a color; anything less is ignored, not half-rendered.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProfiles } from "../src/store.ts";

describe("pi-ext profile store", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pppi-store-"));
		process.env.PPPI_DIR = dir;
	});

	afterEach(() => {
		process.env.PPPI_DIR = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists only profiles with both name and color", () => {
		mkdirSync(join(dir, "profiles"), { recursive: true });
		writeFileSync(
			join(dir, "profiles", "aaa1.json"),
			JSON.stringify({ id: "aaa1", name: "Alpha", color: "#e8b14a", description: "" }),
		);
		writeFileSync(join(dir, "profiles", "bbb2.json"), JSON.stringify({ id: "bbb2", name: "NoColor", description: "" }));
		writeFileSync(join(dir, "profiles", "ccc3.json"), "{not json at all");
		expect(listProfiles().map((p) => p.id)).toEqual(["aaa1"]);
	});

	it("returns [] when no profiles directory exists", () => {
		expect(listProfiles()).toEqual([]);
	});
});
