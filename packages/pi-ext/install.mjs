#!/usr/bin/env bun
// Install the pppi pi extension into pi's global extensions dir.
//
//   bun run packages/pi-ext/install.mjs
//
// Result: ~/.pi/agent/extensions/pppi/index.ts (+ ./src and ./vendor)
// Restart any running pi sessions afterwards.

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const dest = join(homedir(), ".pi", "agent", "extensions", "pppi");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(here, "src"), join(dest, "src"), { recursive: true });
cpSync(join(here, "vendor"), join(dest, "vendor"), { recursive: true });
writeFileSync(join(dest, "index.ts"), 'export { default } from "./src/index.ts";\n');

console.log(`pppi extension installed → ${dest}`);
console.log("slash commands: /omni /pair /profile  ·  tool: pppi_profiles");
console.log("restart running pi sessions to pick it up.");
