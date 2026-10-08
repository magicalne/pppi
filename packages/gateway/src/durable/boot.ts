// Factory that assembles the durable omni (driver input): storage, models,
// registry, environment, and a started event stream. Everything pi-specific
// loads through dynamic imports, so hosts that never pick `--agent durable`
// never load pi-durable into their process (same pattern as the SDK spike).

import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { pppiDir } from "../config.ts";
import type { DurableModelsSlice, DurableOmni } from "./durable-driver.ts";

export type DurableStorageSpec = { kind: "sqlite"; path: string } | { kind: "jsonl"; dir: string } | { kind: "memory" };

/**
 * Where the durable omni persists. Default: SQLite under `$PPPI_DIR`.
 * Override with `PPPI_DURABLE_STORAGE` = `memory` | `jsonl:<dir>` |
 * `sqlite:<path>` (tests use temp dirs).
 */
export function durableStorageFromEnv(dir: string = pppiDir()): DurableStorageSpec {
	const spec = process.env.PPPI_DURABLE_STORAGE?.trim();
	if (!spec || spec === "default") return { kind: "sqlite", path: join(dir, "omni-durable.sqlite") };
	if (spec === "memory") return { kind: "memory" };
	if (spec.startsWith("jsonl:")) return { kind: "jsonl", dir: spec.slice("jsonl:".length) };
	if (spec.startsWith("sqlite:")) return { kind: "sqlite", path: spec.slice("sqlite:".length) };
	throw new Error(`bad PPPI_DURABLE_STORAGE "${spec}" — use memory | jsonl:<dir> | sqlite:<path>`);
}

/**
 * pi's default-model resolution: settings `defaultProvider`/`defaultModel`
 * when it resolves, else the first available model (pi: "from settings, else
 * first available"). A conversation without a model starts no runs.
 */
async function ensureDefaultModel(
	conversation: {
		agent(context: unknown): Promise<{ model?: { provider: string; modelId: string } }>;
		configure(change: { model?: { provider: string; modelId: string } | null }, context: unknown): Promise<void>;
	},
	models: DurableModelsSlice,
): Promise<void> {
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	if (agent.model) return;
	let ref: { provider: string; modelId: string } | undefined;
	try {
		const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8")) as {
			defaultProvider?: string;
			defaultModel?: string;
		};
		if (settings.defaultProvider && settings.defaultModel)
			ref = { provider: settings.defaultProvider, modelId: settings.defaultModel };
	} catch {
		// no settings file — fall through to first-available
	}
	if (!ref || !models.getModel(ref.provider, ref.modelId)) {
		const first = (await models.getAvailable())[0];
		if (!first?.provider || !first?.id) return;
		ref = { provider: String(first.provider), modelId: String(first.id) };
	}
	await conversation.configure({ model: ref }, BACKGROUND_CONTEXT);
}

/**
 * Build the durable omni: pi-durable Harness over one storage, registry with
 * CodingTools + the ported omni extension, models from pi's own runtime
 * (~/.pi/agent credentials and catalogs — same source the pi child uses), and
 * a `watchEvents` stream the driver translates.
 */
export async function createDurableOmni(opts: {
	cwd: string;
	storage?: DurableStorageSpec;
	/** Overridable so tests inject a scripted provider. */
	models?: DurableModelsSlice;
}): Promise<DurableOmni> {
	const durable = await import("@earendil-works/pi-durable");
	const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
	const { CodingTools } = await import("@earendil-works/pi-durable/tools");
	const { omniExtension } = await import("./durable-omni.ts");

	const storageSpec = opts.storage ?? durableStorageFromEnv();
	let storage: any;
	if (storageSpec.kind === "sqlite") {
		const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
		mkdirSync(join(storageSpec.path, ".."), { recursive: true });
		storage = await openNodeSqliteStorage(storageSpec.path);
	} else if (storageSpec.kind === "jsonl") {
		const { openNodeJsonlStorage } = await import("@earendil-works/pi-durable/storage/jsonl/node");
		mkdirSync(storageSpec.dir, { recursive: true });
		storage = await openNodeJsonlStorage(storageSpec.dir, BACKGROUND_CONTEXT);
	} else {
		storage = new durable.MemoryStorage();
	}

	let models: DurableModelsSlice;
	if (opts.models) {
		models = opts.models;
	} else {
		// pi's own configured Models collection (auth.json, models.json) — the
		// same credentials the `pi --mode rpc` child uses.
		const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
		models = (await ModelRuntime.create()) as unknown as DurableModelsSlice;
	}

	const registry = durable.createRegistry();
	registry.install(CodingTools as never);
	registry.install(omniExtension as never);

	const harness = await durable.Harness.open(
		storage,
		{
			models: models as never,
			registry,
			env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? opts.cwd }),
		},
		BACKGROUND_CONTEXT,
	);
	harness.resume();
	const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd: opts.cwd } });
	await ensureDefaultModel(conversation as never, models);
	const events = await durable.watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);

	return {
		harness: harness as never,
		conversation: conversation as never,
		models,
		events: events as never,
		context: BACKGROUND_CONTEXT,
	};
}
