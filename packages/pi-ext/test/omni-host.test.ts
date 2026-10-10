// Unit tests for the /pppi_gateway host plumbing (packages/pi-ext/src/omni-host.ts):
// stop/session_shutdown must take the rpc child down, a failed bind must close
// the gateway (audio child + mailbox poll live inside it), and `here` must not
// subscribe this session's bus before the port is actually bound. All seams are
// fakes (HostDeps) — no real pi process, no audio child, no listening socket.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pppiExtension from "../src/index.ts";
import { type HostDeps, startOmniHere, startOmniHost, stopOmniHost } from "../src/omni-host.ts";
import { ExtensionAgentDriver } from "../src/session-driver.ts";
import { readProfile } from "../src/store.ts";

// session-driver imports @pppi/gateway, which only resolves in the installed
// extension layout (<ext>/node_modules), never from a repo checkout. Replace
// the driver class — these tests never touch a real session bus anyway.
vi.mock("../src/session-driver.ts", () => {
	class MockExtensionAgentDriver {
		static instances: MockExtensionAgentDriver[] = [];
		attach = vi.fn();
		dispose = vi.fn();
		refreshStatus = vi.fn();
		constructor(
			_pi: unknown,
			public cwd: string,
		) {
			MockExtensionAgentDriver.instances.push(this);
		}
		setCtx(): void {}
		get info(): { sessionId?: string } {
			return { sessionId: "here-session-1" };
		}
	}
	return { ExtensionAgentDriver: MockExtensionAgentDriver };
});

type FakeFn = ReturnType<typeof vi.fn>;
type MockHereDriver = { attach: FakeFn; dispose: FakeFn; refreshStatus: FakeFn; cwd: string };
const hereDrivers = (): MockHereDriver[] =>
	(ExtensionAgentDriver as unknown as { instances: MockHereDriver[] }).instances;

/** The rpc child the default mode drives (constructed via the fake gateway module). */
class FakeRpcDriver {
	static instances: FakeRpcDriver[] = [];
	start = vi.fn();
	dispose = vi.fn();
	constructor(public opts: { command: string[]; cwd: string }) {
		FakeRpcDriver.instances.push(this);
	}
}

/** First constructed rpc driver — fails loudly when boot never got that far. */
const rpcDriver = (): FakeRpcDriver => {
	const d = FakeRpcDriver.instances[0];
	if (!d) throw new Error("the rpc driver was never constructed");
	return d;
};

describe("/pppi_gateway host", () => {
	let dir: string;
	let notifications: Array<{ message: string; level?: string }>;
	let gateway: { listen: FakeFn; close: FakeFn };
	let createGateway: FakeFn;
	let deps: HostDeps;

	const notify = (message: string, level?: "info" | "error") => notifications.push({ message, level });

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pppi-omni-host-"));
		process.env.PPPI_DIR = dir; // sandbox pair.json / profile writes
		notifications = [];
		gateway = {
			listen: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
		createGateway = vi.fn(async () => gateway);
		deps = {
			loadGatewayModule: async () => ({
				loadOrCreateConfig: () => ({
					token: "test-token",
					port: 45678,
					host: "127.0.0.1",
					cwd: join(dir, "omni-cwd"),
				}),
				createGateway,
				RpcAgentDriver: FakeRpcDriver,
			}),
			gatewayUp: async () => false,
			audioCommand: () => null, // no bun/node runner
			readOmniMark: () => ({ sessionId: "marked-omni-1" }),
			exists: () => true,
		};
		FakeRpcDriver.instances.length = 0;
		hereDrivers().length = 0;
	});

	afterEach(async () => {
		await stopOmniHost(); // drain anything a failed assertion left running
		process.env.PPPI_DIR = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it("starts the rpc child once; stop closes the gateway BEFORE disposing the child", async () => {
		await startOmniHost(notify, deps);
		const driver = rpcDriver();
		expect(driver.start).toHaveBeenCalledTimes(1);
		// the child targets the marked omni session
		expect(driver.opts.command).toContain("marked-omni-1");
		expect(gateway.listen).toHaveBeenCalledWith(45678, "127.0.0.1");
		// no runner found → the gateway is built without an audio child
		expect(createGateway).toHaveBeenCalledWith(
			expect.objectContaining({ audioService: undefined, token: "test-token" }),
		);
		// pairing info landed in the sandboxed PPPI_DIR
		expect(existsSync(join(dir, "pair.json"))).toBe(true);

		await stopOmniHost();
		expect(gateway.close).toHaveBeenCalledTimes(1);
		expect(driver.dispose).toHaveBeenCalledTimes(1);
		// sequencing: sockets and the audio child go down before the child's SIGTERM
		expect(gateway.close.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			driver.dispose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		// a second stop is a no-op
		await stopOmniHost();
		expect(gateway.close).toHaveBeenCalledTimes(1);
		expect(driver.dispose).toHaveBeenCalledTimes(1);
	});

	it("closes the gateway when the port is taken, and never starts the child", async () => {
		gateway.listen = vi.fn(async () => {
			throw new Error("listen EADDRINUSE :::45678");
		});
		await startOmniHost(notify, deps);
		// createGateway already spawned the audio child and the mailbox poll —
		// the failed bind must close, not leak them
		expect(gateway.close).toHaveBeenCalledTimes(1);
		const driver = rpcDriver();
		expect(driver.start).not.toHaveBeenCalled(); // start only runs after a good bind
		expect(driver.dispose).not.toHaveBeenCalled();
		expect(notifications.some((n) => /Could not bind port 45678/.test(n.message))).toBe(true);
		// nothing was left running: a later stop must not re-close
		await stopOmniHost();
		expect(gateway.close).toHaveBeenCalledTimes(1);
	});

	it("session_shutdown stops the gateway and disposes the rpc child", async () => {
		const handlers: Record<string, () => unknown> = {};
		pppiExtension({
			on: (evt: string, fn: () => unknown) => {
				handlers[evt] = fn;
			},
			registerCommand: () => {},
			registerTool: () => {},
		} as never);
		expect(handlers.session_shutdown).toBeTypeOf("function");

		await startOmniHost(notify, deps);
		const driver = rpcDriver();
		await handlers.session_shutdown?.();
		expect(gateway.close).toHaveBeenCalledTimes(1);
		expect(driver.dispose).toHaveBeenCalledTimes(1);
	});

	it("`here` subscribes the session driver only after a successful bind", async () => {
		const pi = { getThinkingLevel: () => "off" };
		const ctx = { cwd: dir, sessionManager: { getEntries: () => [] } };

		gateway.listen = vi.fn(async () => {
			throw new Error("listen EADDRINUSE :::45678");
		});
		await startOmniHere(pi, ctx as never, notify, deps);
		// attach()/dispose() are the mocked driver's spies: neither the session
		// subscription nor a stop was left behind by the failed bind
		expect(hereDrivers().at(-1)?.attach).not.toHaveBeenCalled();
		expect(hereDrivers().at(-1)?.dispose).not.toHaveBeenCalled();

		gateway.listen = vi.fn(async () => {});
		await startOmniHere(pi, ctx as never, notify, deps);
		expect(hereDrivers().at(-1)?.attach).toHaveBeenCalledTimes(1); // subscribed once the gateway listens
		await stopOmniHost();
		expect(hereDrivers().at(-1)?.dispose).toHaveBeenCalledTimes(1);
		expect(gateway.close).toHaveBeenCalledTimes(2); // failed bind + real stop
	});
});

describe("/pppi_profile", () => {
	it("always writes BOTH name and color (the profile contract the gateway reads)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pppi-profile-"));
		process.env.PPPI_DIR = dir;
		process.env.PI_SESSION_ID = "profiled-sess-1";
		try {
			const commands: Record<string, { handler?: (args: string, ctx: unknown) => Promise<void> }> = {};
			pppiExtension({
				on: () => {},
				registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
					commands[name] = def;
				},
				registerTool: () => {},
			} as never);
			const profileCommand = commands.pppi_profile?.handler;
			if (!profileCommand) throw new Error("/pppi_profile was never registered");
			await profileCommand("Mint #5b8c51 keeps the build green", {
				cwd: "/tmp/repo",
				sessionManager: { getSessionFile: () => undefined },
				ui: { notify: () => {} },
			});

			const profile = readProfile("profiled-sess-1");
			expect(profile?.name).toBe("Mint");
			expect(profile?.color).toBe("#5b8c51");
			expect(profile?.description).toBe("keeps the build green");
		} finally {
			process.env.PI_SESSION_ID = undefined;
			process.env.PPPI_DIR = undefined;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
