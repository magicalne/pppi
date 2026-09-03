// sspi pi extension: the slash commands that wire any pi session into sspi.
//
//   /omni     mark this session as the machine's omni agent
//   /pair     show the pairing QR + link for web/android clients
//   /profile  give this session an identity (name/color/description)
//
// plus the `sspi_profiles` tool, which lets agents read each other's
// profiles — the description is how an omni decides whom to delegate to.
//
// Install: bun run packages/pi-ext/install.mjs  (copies this package to
// ~/.pi/agent/extensions/sspi/); restart pi afterwards.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pairUrl, qrText } from "./pair.ts";
import { loadPair, readProfile, selfSessionId, writeOmniMark, writeProfile, listProfiles } from "./store.ts";

// same palette the gateway derives colors from — /profile just picks among these
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

function sessionIdOf(ctx: ExtensionContext): string | undefined {
	return selfSessionId(ctx.sessionManager.getSessionFile() ?? undefined);
}

function suggestedName(ctx: ExtensionContext): string {
	const dir = ctx.cwd.split("/").filter(Boolean).at(-1);
	return dir ?? "pi-session";
}

export default function sspiExtension(pi: ExtensionAPI) {
	pi.registerCommand("omni", {
		description: "Mark this pi session as this machine's sspi omni agent",
		handler: async (_args, ctx) => {
			const id = sessionIdOf(ctx);
			if (!id) {
				ctx.ui.notify("Could not determine this session's id — cannot mark it as omni.", "error");
				return;
			}
			writeOmniMark({ sessionId: id, cwd: ctx.cwd, pid: process.pid, markedAt: Date.now() });
			ctx.ui.notify(
				`This session is now the sspi omni agent.\nsession ${id}\nRestart the sspi gateway to attach to it.`,
				"info",
			);
		},
	});

	pi.registerCommand("pair", {
		description: "Show the sspi pairing QR code + link for web/android clients",
		handler: async (_args, ctx) => {
			const pair = loadPair();
			if (!pair) {
				ctx.ui.notify(
					`No sspi pairing info found (${process.env.SSPI_DIR ?? "~/.sspi"}/pair.json).\nStart the sspi gateway once, then retry.`,
					"error",
				);
				return;
			}
			const qr = qrText(pair);
			const url = pairUrl(pair);
			ctx.ui.notify(
				[
					`sspi pairing — machine "${pair.machine}" · fingerprint ${pair.fingerprint}`,
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

	pi.registerCommand("profile", {
		description: "Create or update this session's sspi profile (name · color · description)",
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

			// non-interactive form: /profile Joe #e8b14a Maintains the pigeon repo
			const parts = args.trim().length ? args.trim().split(/\s+/) : [];
			if (parts.length) {
				name = parts[0] ?? name;
				const colorArg = parts[1];
				if (colorArg && /^#[0-9a-f]{6}$/i.test(colorArg)) color = colorArg;
				description = parts.slice(2).join(" ");
			} else if (ctx.hasUI) {
				name = (await ctx.ui.input("Profile name", existing?.name ?? suggestedName(ctx))) ?? name;
				const picked = await ctx.ui.select(
					`Color for "${name}" (now ${color})`,
					COLORS,
				);
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
		name: "sspi_profiles",
		label: "sspi_profiles",
		description:
			"List sspi profiles of pi sessions on this machine: name, color and description. " +
			"Read the descriptions to decide which session to delegate work to (via pigeon send).",
		parameters: Type.Object({}),
		execute: async (_toolCallId: string) => {
			const profiles = listProfiles();
			if (profiles.length === 0) {
				return { content: [{ type: "text", text: "no profiles yet — sessions can create one with /profile" }], details: {} };
			}
			const body = profiles
				.map((p) => `${p.name} (${p.color}) — ${p.description} [id: ${p.id.slice(0, 8)}…]`)
				.join("\n");
			return { content: [{ type: "text", text: body }], details: {} };
		},
	});
}
