#!/usr/bin/env bun
// Install the pppi pi extension into pi's global extensions dir.
//
//   bun run install:ext
//
// Result: ~/.pi/agent/extensions/pppi/{index.ts,src,vendor} plus the gateway
// runtime the /omni command boots: node_modules/@pppi/{gateway,protocol,omni},
// pure-JS deps (ws, minimatch), web/ (the built client), and symlinks to this
// repo's native voice deps when present (transcribe-cpp, kokoro, onnx).
// Restart any running pi sessions afterwards.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(join(here, "..", ".."));
const dest = join(homedir(), ".pi", "agent", "extensions", "pppi");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(here, "src"), join(dest, "src"), { recursive: true });
cpSync(join(here, "vendor"), join(dest, "vendor"), { recursive: true });
writeFileSync(join(dest, "index.ts"), 'export { default } from "./src/index.ts";\n');

// ---- gateway runtime for /omni --------------------------------------------

function copyDirs(name, fromDir, dirs) {
	const nm = join(dest, "node_modules", name);
	mkdirSync(dirname(nm), { recursive: true });
	for (const dir of dirs) {
		cpSync(join(fromDir, dir), join(nm, dir), { recursive: true, dereference: true });
	}
}

// copy only what the runtime needs — never the workspace package's
// node_modules (its symlinks would dereference hundreds of MB)
copyDirs("@pppi/gateway", join(repoRoot, "packages", "gateway"), ["src", "assets", "package.json"]);
copyDirs("@pppi/protocol", join(repoRoot, "packages", "protocol"), ["src", "package.json"]);
copyDirs("@pppi/omni", join(repoRoot, "packages", "omni"), ["src", "package.json"]);

// runtime deps of the gateway. bun's isolated store keeps packages in
// node_modules/.bun; resolve each through the gateway package so the layout
// doesn't matter.
const gatewayRequire = createRequire(join(repoRoot, "packages", "gateway", "package.json"));
function depDir(dep) {
	try {
		return dirname(gatewayRequire.resolve(join(dep, "package.json")));
	} catch {
		return null;
	}
}
for (const dep of ["ws", "minimatch"]) {
	const from = depDir(dep);
	if (from) {
		const to = join(dest, "node_modules", dep);
		mkdirSync(dirname(to), { recursive: true });
		cpSync(from, to, { recursive: true, dereference: true });
	}
}

// minimatch's transitive dep — bun's versioned store keeps it at
// .bun/brace-expansion@x/node_modules/brace-expansion; symlink the newest one
try {
	const store = join(repoRoot, "node_modules", ".bun");
	const found = readdirSync(store)
		.filter((e) => e.startsWith("brace-expansion@"))
		.sort()
		.at(-1);
	if (found) {
		const beTo = join(dest, "node_modules", "brace-expansion");
		symlinkSync(join(store, found, "node_modules", "brace-expansion"), beTo, "dir");
	}
} catch {
	// unusual layout — voice/model-list filtering degrades, nothing else breaks
}

// native voice deps stay OUT of the extension dir; symlink this repo's copies
// so the audio-service child finds them on dev machines (missing → voice
// degrades gracefully, /api/health reports why)
for (const dep of ["transcribe-cpp", "kokoro-js", "onnxruntime-node", "onnxruntime-common", "onnxruntime-web"]) {
	const from = depDir(dep);
	const to = join(dest, "node_modules", dep);
	try {
		if (from) symlinkSync(from, to, "dir");
	} catch {
		// already there / unsupported fs — degradation covers it
	}
}

// the built web client
const webDist = join(repoRoot, "apps", "web", "dist");
if (existsSync(webDist)) cpSync(webDist, join(dest, "web"), { recursive: true });

// stamp the repo root so the audio child can fall back to the repo's modules
writeFileSync(join(dest, "repo.json"), `${JSON.stringify({ repoRoot }, null, "\t")}\n`);

// stamp WHICH build this is — the gateway serves it at /api/health so a stale
// install can't silently masquerade as the repo's current code
const version = { sha: "unknown", committedAt: null, dirty: false, packagedAt: new Date().toISOString() };
try {
	version.sha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
	version.committedAt = execFileSync("git", ["log", "-1", "--format=%cI"], { cwd: repoRoot, encoding: "utf8" }).trim();
	version.dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0;
} catch {
	// not a git checkout — packagedAt still tells the story
}
writeFileSync(join(dest, "version.json"), `${JSON.stringify(version, null, "\t")}\n`);

console.log(`pppi extension installed → ${dest}`);
console.log(`gateway stamp: ${version.sha}${version.dirty ? " (dirty tree)" : ""} — packaged ${version.packagedAt}`);
console.log("slash commands: /omni /pair /profile  ·  tool: pppi_profiles");
console.log("/omni boots the gateway from a pi session; restart running pi sessions to pick it up.");
