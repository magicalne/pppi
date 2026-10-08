// Durable omni driver tests — real pi-durable over injected storage + a
// scripted fake provider (hermetic; no credentials). Locks the plan's
// acceptance criteria: event parity, steer-while-busy, restart survival,
// newSession/reset, model errors, and the ported omni extension.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDurableOmni } from "../src/durable/boot.ts";
import { DurableAgentDriver } from "../src/durable/durable-driver.ts";
import { omniExtension } from "../src/durable/durable-omni.ts";
import { FakeProvider } from "./helpers/fake-provider.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pppi-durable-"));
}

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) {
		for (const f of [d, `${d}-wal`, `${d}-shm`]) rmSync(f, { force: true, recursive: true });
	}
});

/** A driver factory over the given storage spec, sharing one fake provider + models. */
function makeFactory(
	storage: { kind: "memory" } | { kind: "sqlite"; path: string },
	provider: FakeProvider,
	spied?: { drafts: Array<Record<string, any>> },
) {
	const models = createModels();
	models.setProvider(provider as never);
	return async () => {
		const omni = await createDurableOmni({ cwd: tmpdir(), storage, models: models as never });
		if (spied) {
			const inner = omni.conversation.submit.bind(omni.conversation);
			omni.conversation.submit = ((draft: Record<string, any>, ctx: unknown) => {
				spied.drafts.push({ ...draft });
				return inner(draft as never, ctx as never);
			}) as typeof omni.conversation.submit;
		}
		return omni;
	};
}

function logEvents(driver: DurableAgentDriver) {
	const log: string[] = [];
	const finals: string[] = [];
	const deltas: string[] = [];
	driver.on("state", (s) => log.push(`state:${s}`));
	driver.on("assistant-delta", (_id, d) => {
		deltas.push(d);
		log.push("delta");
	});
	driver.on("assistant-final", (_id, t) => {
		finals.push(t);
		log.push("final");
	});
	driver.on("notify", (level, m) => log.push(`notify:${level}:${m}`));
	return { log, finals, deltas };
}

async function started(driver: DurableAgentDriver): Promise<void> {
	driver.start();
	await new Promise<void>((r) => driver.once("ready", r));
}

const until = async (check: () => boolean, ms = 10_000): Promise<void> => {
	const step = 25;
	for (let waited = 0; !check(); waited += step) {
		if (waited >= ms) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, step));
	}
};

describe("durable omni agent driver", () => {
	beforeEach(() => {
		process.env.PPPI_DIR = tempDir();
	});
	afterEach(() => {
		process.env.PPPI_DIR = undefined;
	});

	it("scripted turn: thinking→streaming→idle, deltas, final, history newest-last", async () => {
		const provider = new FakeProvider();
		const driver = new DurableAgentDriver({ cwd: tmpdir(), create: makeFactory({ kind: "memory" }, provider) });
		const seen = logEvents(driver);
		await started(driver);
		expect(driver.state).toBe("idle");
		expect(driver.info.model).toMatchObject({ provider: "pppi-test", id: "fake-1" });

		await driver.prompt("hello durable omni");
		await until(() => seen.finals.length >= 1);
		await until(() => driver.state === "idle");

		expect(seen.log).toContain("state:thinking");
		expect(seen.log).toContain("state:streaming");
		// message_start carries the first committed partial; later partials diff
		// as deltas — so the deltas are a tail of the reply, never duplicates
		expect(seen.deltas.length).toBeGreaterThanOrEqual(1);
		expect("ack from the durable omni".endsWith(seen.deltas.join(""))).toBe(true);
		expect(seen.finals).toEqual(["ack from the durable omni"]);

		const history = await driver.history();
		expect(history.entries.map((e) => e.role)).toEqual(["user", "assistant"]);
		expect(history.entries[0]?.text).toBe("hello durable omni");
		expect(history.entries[1]?.text).toBe("ack from the durable omni");
		expect(history.hasMore).toBe(false);
		driver.dispose();
	});

	it("prompt(steer) while busy submits with whenBusy=steer (streaming-feedback path)", async () => {
		const provider = new FakeProvider();
		const spy = { drafts: [] as Array<Record<string, any>> };
		let release: () => void = () => {};
		provider.gate = new Promise<void>((r) => {
			release = r;
		});
		const driver = new DurableAgentDriver({ cwd: tmpdir(), create: makeFactory({ kind: "memory" }, provider, spy) });
		const seen = logEvents(driver);
		await started(driver);

		await driver.prompt("first thought");
		await until(() => seen.deltas.length >= 1); // busy: generation in flight
		await driver.prompt("and the rest of it", { deliver: "steer" });
		release();
		await until(() => seen.finals.length >= 2);
		await until(() => driver.state === "idle");

		// the busy prompt went out as a steer, not the default followUp
		expect(spy.drafts[0]).toMatchObject({ type: "input", content: "first thought" });
		expect(spy.drafts[0]?.whenBusy).toBeUndefined();
		expect(spy.drafts[1]).toMatchObject({ type: "input", content: "and the rest of it", whenBusy: "steer" });
		// pi-durable places a steer at the next turn boundary: the remainder
		// becomes the next turn (answered in order, nothing duplicated)
		const history = await driver.history();
		expect(history.entries.map((e) => e.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(history.entries[2]?.text).toBe("and the rest of it");
		driver.dispose();
	});

	it("RESTART SURVIVAL: disposed mid-generation, a second driver resumes and completes exactly once", async () => {
		const dbPath = join(tempDir(), "omni.sqlite");
		const provider = new FakeProvider();
		let release: () => void = () => {};
		provider.gate = new Promise<void>((r) => {
			release = r;
		});

		const driverA = new DurableAgentDriver({
			cwd: tmpdir(),
			create: makeFactory({ kind: "sqlite", path: dbPath }, provider),
		});
		const seenA = logEvents(driverA);
		await started(driverA);
		await driverA.prompt("survive the crash please");
		await until(() => seenA.deltas.length >= 1); // mid-generation: partial committed, done gated
		expect(seenA.finals).toHaveLength(0);
		driverA.dispose(); // "process died" mid-turn

		release(); // the world moves on while we are down

		const driverB = new DurableAgentDriver({
			cwd: tmpdir(),
			create: makeFactory({ kind: "sqlite", path: dbPath }, provider),
		});
		const seenB = logEvents(driverB);
		await started(driverB);
		await until(() => seenB.finals.length >= 1, 15_000);
		await until(() => driverB.state === "idle", 15_000);

		// exactly one final; the recovered partial (aborted) never surfaces as one
		expect(seenB.finals).toEqual(["ack from the durable omni"]);
		const history = await driverB.history();
		expect(history.entries.map((e) => e.role)).toEqual(["user", "assistant"]);
		expect(history.entries[0]?.text).toBe("survive the crash please");
		// the provider answered the original attempt and the resumed attempt — nothing else
		expect(provider.calls).toHaveLength(2);
		driverB.dispose();
	});

	it("newSession resets the visible transcript", async () => {
		const provider = new FakeProvider();
		const driver = new DurableAgentDriver({ cwd: tmpdir(), create: makeFactory({ kind: "memory" }, provider) });
		const seen = logEvents(driver);
		await started(driver);
		await driver.prompt("one");
		await until(() => seen.finals.length >= 1);
		await driver.newSession();
		const history = await driver.history();
		expect(history.entries).toHaveLength(0);
		driver.dispose();
	});

	it("rejects unknown models like the other drivers", async () => {
		const provider = new FakeProvider();
		const driver = new DurableAgentDriver({ cwd: tmpdir(), create: makeFactory({ kind: "memory" }, provider) });
		await started(driver);
		await expect(driver.setModel("pppi-test", "nope")).rejects.toThrow(/Model not found/);
		const models = await driver.availableModels();
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ provider: "pppi-test", id: "fake-1" });
		driver.dispose();
	});
});

describe("durable omni extension (ported tools)", () => {
	beforeEach(() => {
		process.env.PPPI_DIR = tempDir();
	});
	afterEach(() => {
		process.env.PPPI_DIR = undefined;
	});

	function tool(name: string) {
		const t = (
			omniExtension as unknown as {
				tools: Array<{ name: string; execute: (args: any, api: any, ctx: any) => Promise<any> }>;
			}
		).tools.find((t) => t.name === name);
		if (!t) throw new Error(`tool ${name} not registered`);
		return t;
	}

	function resultText(res: any): string {
		return (res?.content ?? []).map((c: any) => c.text ?? "").join("");
	}

	it("omni_repos add + list against a temp PPPI_DIR (pigeon absent degrades gracefully)", async () => {
		const repoDir = tempDir();
		execFileSync("git", ["init", "-q", repoDir]);

		const add = await tool("omni_repos").execute(
			{ action: "add", path: repoDir, name: "tmp-repo" },
			{},
			BACKGROUND_CONTEXT,
		);
		expect(resultText(add)).toMatch(/registered repo "tmp-repo"/);

		const list = await tool("omni_repos").execute({ action: "list" }, {}, BACKGROUND_CONTEXT);
		expect(resultText(list)).toContain("tmp-repo");
		// no pigeon binary on this machine — the session line degrades, it does not throw
		expect(resultText(list)).toMatch(/no open sessions|could not list sessions/);
	});

	it("pppi_profiles lists explicit profiles from the temp dir", async () => {
		const profiles = join(process.env.PPPI_DIR!, "profiles");
		mkdirSync(profiles, { recursive: true });
		writeFileSync(
			join(profiles, "session-1.json"),
			JSON.stringify({ name: "Repo Bot", color: "#e8b14a", description: "runs the builds" }),
		);
		const res = await tool("pppi_profiles").execute({}, {}, BACKGROUND_CONTEXT);
		expect(resultText(res)).toContain("Repo Bot (#e8b14a) — runs the builds");
	});
});
