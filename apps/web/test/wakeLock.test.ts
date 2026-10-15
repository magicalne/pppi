import { describe, expect, it } from "vitest";
import { WAKE_LOCK_KEY, type WakeLockSentinelLike, createWakeLockController } from "../src/wakeLock.ts";

class MockSentinel implements WakeLockSentinelLike {
	released = false;
	private listeners: (() => void)[] = [];
	async release(): Promise<void> {
		this.released = true;
		this.fire();
	}
	addEventListener(_type: "release", listener: () => void): void {
		this.listeners.push(listener);
	}
	fire(): void {
		for (const l of this.listeners) l();
	}
}

function mockWakeLock(opts: { failWith?: Error } = {}) {
	const sentinels: MockSentinel[] = [];
	let failWith = opts.failWith ?? null;
	const wakeLock = {
		request: async (_type: "screen") => {
			requests++;
			if (failWith) throw failWith;
			const s = new MockSentinel();
			sentinels.push(s);
			return s;
		},
	};
	let requests = 0;
	return {
		wakeLock: () => wakeLock as unknown as { request: (t: "screen") => Promise<MockSentinel> },
		sentinels,
		requestCount: () => requests,
		failWith(err: Error | null) {
			failWith = err;
		},
	};
}

function mockStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => {
			map.set(k, v);
		},
		_dump: () => map,
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("wake lock: acquire/release on activity", () => {
	it("acquires when active and releases when idle", async () => {
		const { wakeLock, sentinels } = mockWakeLock();
		const states: string[] = [];
		const ctl = createWakeLockController({ wakeLock, onStateChange: (s) => states.push(s) });
		expect(ctl.getState()).toBe("unlocked");

		ctl.update(true);
		await tick();
		expect(sentinels.length).toBe(1);
		expect(ctl.getState()).toBe("locked");

		ctl.update(false);
		await tick();
		expect(sentinels[0]!.released).toBe(true);
		expect(ctl.getState()).toBe("unlocked");
		expect(states).toEqual(["locked", "unlocked"]);
	});

	it("no double request while a acquire is pending", async () => {
		const { wakeLock, sentinels } = mockWakeLock();
		const ctl = createWakeLockController({ wakeLock });
		ctl.update(true);
		ctl.update(true); // same value — ignored
		await tick();
		expect(sentinels.length).toBe(1);
	});

	it("release wins when activity ends while the request is in flight", async () => {
		const { wakeLock, sentinels } = mockWakeLock();
		const ctl = createWakeLockController({ wakeLock });
		ctl.update(true);
		ctl.update(false); // goes idle before the promise resolves
		await tick();
		await tick();
		expect(sentinels.length).toBe(1);
		expect(sentinels[0]!.released).toBe(true);
		expect(ctl.getState()).toBe("unlocked");
	});

	it("destroy releases a held lock", async () => {
		const { wakeLock, sentinels } = mockWakeLock();
		const ctl = createWakeLockController({ wakeLock });
		ctl.update(true);
		await tick();
		ctl.destroy();
		await tick();
		expect(sentinels[0]!.released).toBe(true);
	});
});

describe("wake lock: user toggle", () => {
	it("persists to storage and forces the lock when idle", async () => {
		const storage = mockStorage();
		const { wakeLock, sentinels } = mockWakeLock();
		const ctl = createWakeLockController({ wakeLock, storage });
		ctl.setToggle(true);
		await tick();
		expect(storage._dump().get(WAKE_LOCK_KEY)).toBe("1");
		expect(sentinels.length).toBe(1); // acquired without any activity

		ctl.setToggle(false);
		await tick();
		expect(storage._dump().get(WAKE_LOCK_KEY)).toBe("0");
		expect(sentinels[0]!.released).toBe(true);
	});

	it("a new controller reads the toggle from storage", async () => {
		const storage = mockStorage();
		storage.setItem(WAKE_LOCK_KEY, "1");
		const { wakeLock, sentinels } = mockWakeLock();
		const ctl = createWakeLockController({ wakeLock, storage });
		expect(ctl.getToggle()).toBe(true);
		ctl.update(false); // no activity — toggle still holds the lock
		await tick();
		expect(sentinels.length).toBe(1);
		expect(ctl.getState()).toBe("locked");
	});
});

describe("wake lock: visibility re-acquire", () => {
	it("re-acquires after a surprise release while visible", async () => {
		const { wakeLock, sentinels } = mockWakeLock();
		const ctl = createWakeLockController({ wakeLock, isVisible: () => true });
		ctl.update(true);
		await tick();
		sentinels[0]!.fire(); // UA dropped the lock (e.g. tab was hidden, now back)
		await tick();
		expect(sentinels.length).toBe(2);
		expect(ctl.getState()).toBe("locked");
	});

	it("stays released while hidden, then onVisible() re-acquires", async () => {
		const { wakeLock, sentinels } = mockWakeLock();
		const ctl = createWakeLockController({ wakeLock, isVisible: () => false });
		ctl.update(true);
		await tick();
		sentinels[0]!.fire(); // released because the tab hid — do NOT grab it back in the dark
		await tick();
		expect(sentinels.length).toBe(1);
		expect(ctl.getState()).toBe("unlocked");

		ctl.onVisible(); // visibilitychange → visible
		await tick();
		expect(sentinels.length).toBe(2);
		expect(ctl.getState()).toBe("locked");
	});

	it("our own release does not trigger re-acquire", async () => {
		const { wakeLock, sentinels } = mockWakeLock();
		const ctl = createWakeLockController({ wakeLock, isVisible: () => true });
		ctl.update(true);
		await tick();
		ctl.update(false); // releases; the sentinel fires its release event
		await tick();
		await tick();
		expect(sentinels.length).toBe(1);
		expect(ctl.getState()).toBe("unlocked");
	});
});

describe("wake lock: graceful degradation", () => {
	it("unsupported platform is a no-op", async () => {
		const ctl = createWakeLockController({ wakeLock: () => undefined });
		ctl.update(true);
		ctl.setToggle(true);
		await tick();
		expect(ctl.getState()).toBe("unsupported");
		expect(() => ctl.onVisible()).not.toThrow();
	});

	it("bare controller in node (no navigator/localStorage) does not throw", async () => {
		const ctl = createWakeLockController();
		ctl.update(true);
		await tick();
		expect(["unsupported", "unlocked"]).toContain(ctl.getState());
	});

	it("NotAllowedError reports denied; retries only on explicit onVisible", async () => {
		const { wakeLock, sentinels, requestCount } = mockWakeLock({
			failWith: Object.assign(new Error("denied"), { name: "NotAllowedError" }),
		});
		const ctl = createWakeLockController({ wakeLock, isVisible: () => true });
		ctl.update(true);
		await tick();
		expect(ctl.getState()).toBe("denied");
		expect(requestCount()).toBe(1); // no background retry loop

		ctl.onVisible(); // an explicit user-driven event may retry once
		await tick();
		expect(requestCount()).toBe(2);
		expect(ctl.getState()).toBe("denied");
		expect(sentinels.length).toBe(0); // nothing ever held
	});
});
