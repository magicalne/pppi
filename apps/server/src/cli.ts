// sspi server CLI.
//
//   bun run apps/server/src/cli.ts [--port 8787] [--host 0.0.0.0] [--token X]
//                                 [--cwd ~/.sspi/omni-home] [--agent-cmd "..."]
//                                 [--no-stt]

import { existsSync, mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcAgentDriver } from "./agent.ts";
import { loadOrCreateConfig } from "./config.ts";
import { createServer } from "./server.ts";
import { Stt } from "./stt.ts";

function parseArgs(argv: string[]): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined || !a.startsWith("--")) continue;
		const key = a.slice(2);
		if (key === "no-stt") out[key] = true;
		else out[key] = argv[++i] ?? "";
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const cfg = loadOrCreateConfig({
	port: args.port ? Number(args.port) : undefined,
	host: args.host ? String(args.host) : undefined,
	token: args.token ? String(args.token) : undefined,
	cwd: args.cwd ? String(args.cwd) : undefined,
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const extensionPath = join(repoRoot, "extensions", "omni.ts");

const agentCmd = args["agent-cmd"]
	? String(args["agent-cmd"]).split(/\s+/)
	: ["pi", "--mode", "rpc", "--session-id", "sspi-omni", "--no-approve", "-e", extensionPath];

mkdirSync(cfg.cwd, { recursive: true });

const driver = new RpcAgentDriver({ command: agentCmd, cwd: cfg.cwd });
const stt = Stt.create({ disabled: args["no-stt"] === true });
const sttStatus = stt.status;

const webDist = join(repoRoot, "apps", "web", "dist");
const app = await createServer({
	token: cfg.token,
	driver,
	stt,
	webDist: existsSync(webDist) ? webDist : undefined,
});

await app.listen({ port: cfg.port, host: cfg.host });
driver.start();

const shownHost = cfg.host === "0.0.0.0" || cfg.host === "::" ? lanIp() ?? "<this-mac>" : cfg.host;
console.log(`
        ┌──────┐         ┌──────┐         ┌──────┐
        │ sspi │ ──────► │  *p  │ ──────► │  pi  │
        └──────┘         └──────┘         └──────┘
       pointer ──► pointer ──► pi   (one omni agent, every screen)

  local     http://localhost:${cfg.port}
  lan       http://${shownHost}:${cfg.port}
  pairing   token ${cfg.token.slice(0, 4)}…${cfg.token.slice(-4)}   (full token in ${cfg.configPath})
  agent     ${agentCmd.join(" ")}
  stt       ${sttStatus.ready ? `ready (${sttStatus.modelId})` : sttStatus.reason}
  clients   open the URL on your phone, enter the token once. Voice is the big button.
`);

function lanIp(): string | null {
	for (const list of Object.values(networkInterfaces())) {
		for (const ni of list ?? []) {
			if (ni.family === "IPv4" && !ni.internal) return ni.address;
		}
	}
	return null;
}

async function shutdown() {
	console.log("\nsspi: shutting down");
	await app.close();
	driver.dispose();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
