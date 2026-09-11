// pppi pi extension: the slash commands that wire any pi session into pppi.
//
//   /pppi_gateway [here|mark|stop]  boot the gateway from this session
//   /pppi_pair                     show the pairing QR + link for web/android
//   /pppi_profile                  give this session an identity
//                                  (name/color/description)
//
// plus the `pppi_profiles` tool, which lets agents read each other's
// profiles — the description is how an omni decides whom to delegate to.
//
// Install: bun run packages/pi-ext/install.mjs  (copies this package to
// ~/.pi/agent/extensions/pppi/); restart pi afterwards.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { startOmniHere, startOmniHost, stopOmniHost } from "./omni-host.ts";
import { pairUrl, qrText } from "./pair.ts";
import { listProfiles, loadPair, readProfile, selfSessionId, writeOmniMark, writeProfile } from "./store.ts";

// same palette the gateway derives colors from — /pppi_profile just picks among these
const COLORS = [
	"amber #e8b14a",
	"matcha #5b8c51",
	"periwinkle #7aa2ff",
	"ember #d96c47",
	"lilac #b48ead",
	"teal #4fb0a5",
	"rose #e05f65",
	"moss #8fae5b",
	"caramel #c78a4d",
	"steel #6f8db9",
];

function sessionIdOf(ctx: { sessionManager: { getSessionFile(): string | undefined } }): string | undefined {
	return selfSessionId(ctx.sessionManager.getSessionFile() ?? undefined);
}

function suggestedName(ctx: { cwd: string }): string {
	const dir = ctx.cwd.split("/").filter(Boolean).at(-1);
	return dir ?? "pi-session";
}

export default function pppiExtension(pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		await stopOmniHost();
	});

	pi.registerCommand("pppi_gateway", {
		description:
			"pppi: boot the gateway from this session (clients pair while this session lives). Modes: (default) launch the omni as an rpc child · `here` THIS session becomes the omni · `mark` tag this session as the child target · `stop`.",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0];
			if (sub === "stop") {
				await stopOmniHost();
				ctx.ui.notify("pppi gateway stopped.", "info");
				return;
			}
			if (sub === "mark") {
				const id = sessionIdOf(ctx);
				if (!id) {
					ctx.ui.notify("Could not determine this session's id — cannot mark it as omni.", "error");
					return;
				}
				writeOmniMark({ sessionId: id, cwd: ctx.cwd, pid: process.pid, markedAt: Date.now() });
				ctx.ui.notify(
					`This session is now the pppi omni target (session ${id}).\nRestart the gateway to attach.`,
					"info",
				);
				return;
			}
			if (sub === "here") {
				await startOmniHere(pi, ctx, (message, level) => ctx.ui.notify(message, level));
				return;
			}
			await startOmniHost((message, level) => ctx.ui.notify(message, level));
		},
	});

	pi.registerCommand("pppi_pair", {
		description: "Show the pppi pairing QR code + link for web/android clients",
		handler: async (_args, ctx) => {
			const pair = loadPair();
			if (!pair) {
				// a running gateway with a DIFFERENT PPPI_DIR is the classic trap —
				// detect it so the message says what to actually fix
				let mismatch = false;
				try {
					const res = await fetch("http://127.0.0.1:8787/api/health");
					mismatch = ((await res.json()) as { name?: string })?.name === "pppi";
				} catch {
					// nothing on the default port
				}
				const dir = process.env.PPPI_DIR ?? "~/.pppi";
				ctx.ui.notify(
					mismatch
						? `A gateway is running on :8787, but this session has no pair info in ${dir}/pair.json.\nThe gateway was started with a different PPPI_DIR — restart it without PPPI_DIR (default ~/.pppi), or export the same PPPI_DIR here, then retry.`
						: `No pppi pairing info found (${dir}/pair.json).\nRun /pppi_gateway (or start the standalone gateway), then retry.`,
					"error",
				);
				return;
			}
			const qr = qrText(pair);
			const url = pairUrl(pair);
			ctx.ui.notify(
				[
					`pppi pairing — machine "${pair.machine}" · fingerprint ${pair.fingerprint}`,
					qr ? `\n${qr}` : "",
					`\n${url}`,
					"\nweb: open this link.  android: sessions menu → + → scan or paste.",
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("pppi_profile", {
		description: "Create or update this session's pppi profile (name · color · description)",
		handler: async (args, ctx) => {
			const id = sessionIdOf(ctx);
			if (!id) {
				ctx.ui.notify("Could not determine this session's id — cannot write a profile.", "error");
				return;
			}
			const existing = readProfile(id);
			let name = existing?.name ?? suggestedName(ctx);
			let color = existing?.color ?? "#e8b14a";
			let description = existing?.description ?? "";

			// non-interactive form: /pppi_profile Joe #e8b14a Maintains the pigeon repo
			const parts = args.trim().length ? args.trim().split(/\s+/) : [];
			if (parts.length) {
				name = parts[0] ?? name;
				const colorArg = parts[1];
				if (colorArg && /^#[0-9a-f]{6}$/i.test(colorArg)) color = colorArg;
				description = parts.slice(2).join(" ");
			} else if (ctx.hasUI) {
				name = (await ctx.ui.input("Profile name", existing?.name ?? suggestedName(ctx))) ?? name;
				const picked = await ctx.ui.select(`Color for "${name}" (now ${color})`, COLORS);
				if (picked) {
					const hex = picked.match(/#[0-9a-f]{6}/i);
					if (hex) color = hex[0];
				}
				description =
					(await ctx.ui.input(
						"Description — what is this session for? (other agents read this)",
						existing?.description ?? "",
					)) ?? description;
			}

			writeProfile({ id, name, color, description: description || "pi session" });
			ctx.ui.notify(`Profile saved: ${name} (${color}) — id ${id.slice(0, 8)}…`, "info");
		},
	});

	pi.registerTool({
		name: "pppi_profiles",
		label: "pppi_profiles",
		description:
			"List pppi profiles of pi sessions on this machine: name, color and description. " +
			"Read the descriptions to decide which session to delegate work to (via pigeon send).",
		parameters: Type.Object({}),
		execute: async (_toolCallId: string) => {
			const profiles = listProfiles();
			if (profiles.length === 0) {
				return {
					content: [{ type: "text", text: "no profiles yet — sessions can create one with /pppi_profile" }],
					details: {},
				};
			}
			const body = profiles
				.map((p) => `${p.name} (${p.color}) — ${p.description} [id: ${p.id.slice(0, 8)}…]`)
				.join("\n");
			return { content: [{ type: "text", text: body }], details: {} };
		},
	});
}
