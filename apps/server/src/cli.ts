// pppi server CLI — the standalone gateway host (headless / daemon use).
// The same gateway also runs inside a pi session via the pppi extension's
// /omni command; this entry stays for unattended machines.
//
//   bun run apps/server/src/cli.ts [--port 8787] [--host 0.0.0.0] [--token X]
//                                 [--cwd ~/.pppi/omni-home] [--agent-cmd "..."]
//                                 [--no-stt]

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	RpcAgentDriver,
	Stt,
	buildPairInfo,
	createGateway,
	loadOrCreateConfig,
	pppiDir,
	resolveTtsProvider,
	writePairFile,
} from "@pppi/gateway";
import QRCode from "qrcode";

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

// ------------------------------------------------------------------ pairing

const pair = buildPairInfo(cfg);
writePairFile(pair);

// ------------------------------------------------------------- omni marking
// `/pppi_gateway mark` (pi extension) writes omni.json marking which session is the
// machine's omni; the gateway resumes that session by id.

function markedOmniSession(): string | null {
	const p = join(pppiDir(), "omni.json");
	if (!existsSync(p)) return null;
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as { sessionId?: string };
		return typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null;
	} catch {
		return null;
	}
}

const omniSessionId = markedOmniSession() ?? "pppi-omni";

const agentCmd = args["agent-cmd"]
	? String(args["agent-cmd"]).split(/\s+/)
	: ["pi", "--mode", "rpc", "--session-id", omniSessionId, "--no-approve", "-e", extensionPath];

mkdirSync(cfg.cwd, { recursive: true });

const driver = new RpcAgentDriver({ command: agentCmd, cwd: cfg.cwd });
const stt = Stt.create({ disabled: args["no-stt"] === true });
const sttStatus = stt.status;

const webDist = join(repoRoot, "apps", "web", "dist");
const tts = resolveTtsProvider();
const gateway = await createGateway({
	token: cfg.token,
	agent: driver,
	stt,
	webDist: existsSync(webDist) ? webDist : undefined,
	pair,
	tts,
});

await gateway.listen(cfg.port, cfg.host);
driver.start();

const shownHost = cfg.host === "0.0.0.0" || cfg.host === "::" ? (pair.ips[0] ?? "<this-mac>") : cfg.host;
const pairUrl = pair.urls[0] ?? `http://localhost:${cfg.port}`;
const qr = await QRCode.toString(pairUrl, { type: "terminal", small: true }).catch(() => null);
console.log(`
        ┌──────┐         ┌──────┐         ┌──────┐
        │ pppi │ ──────► │  *p  │ ──────► │  pi  │
        └──────┘        └──────┘        └──────┘
       pointer ──► pointer ──► pi   (one omni agent, every screen)

  local     http://localhost:${cfg.port}
  lan       http://${shownHost}:${cfg.port}
  pair      ${pairUrl}?pair=${cfg.token}
            machine "${pair.machine}" · fingerprint ${pair.fingerprint}
  omni      session ${omniSessionId}${markedOmniSession() ? " (marked via /pppi_gateway mark)" : ""}
  agent     ${agentCmd.join(" ")}
  stt       ${sttStatus.ready ? `ready (${sttStatus.modelId})` : sttStatus.reason}
  tts       ${tts.status.ready ? `ready (${tts.id} · ${tts.status.voice})` : tts.status.reason}
  clients   scan this on the android app, or open the pair link in a browser.
            web: enter the token at the URL below. Voice is the big button.
${qr ? `\n${qr}\n` : ""}
        web app  →  ${pairUrl}
`);

async function shutdown() {
	console.log("\npppi: shutting down");
	await gateway.close();
	driver.dispose();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
