import { describe, expect, it } from "vitest";
import { ReconnectController, type ReconnectOpts, mergeResume, shouldAutoResumeVoice } from "../src/reconnect.ts";

/** fake timer bank: capture scheduled callbacks, fire them manually */
function fakeTimers() {
	const bank: Array<{ fn: () => void; at: number; fired: boolean }> = [];
	return {
		schedule: (fn: () => void, ms: number) => {
			const t = { fn, at: ms, fired: false };
			bank.push(t);
			return t;
		},
		cancel: (t: unknown) => {
			const i = bank.indexOf(t as (typeof bank)[number]);
			if (i >= 0) bank.splice(i, 1);
		},
		/** run the earliest pending callback; returns its delay or null */
		fireNext: (): number | null => {
			if (bank.length === 0) return null;
			bank.sort((a, b) => a.at - b.at);
			const t = bank.shift()!;
			t.fired = true;
			t.fn();
			return t.at;
		},
		pending: () => bank.length,
	};
}

function makeController(opts: Partial<ReconnectOpts> = {}) {
	const timers = fakeTimers();
	const retries: number[] = [];
	const states: string[] = [];
	const rc = new ReconnectController({
		jitter: () => 0.5, // exact delay = exp * 1.0 — deterministic
		setTimeoutFn: timers.schedule,
		clearTimeoutFn: timers.cancel,
		onStateChange: (s) => states.push(s),
		onRetry: () => retries.push(1),
		...opts,
	});
	return { rc, timers, retries, states };
}

describe("reconnect: backoff ladder", () => {
	it("grows exponentially and caps at maxMs", () => {
		const { rc, timers } = makeController({ baseMs: 500, maxMs: 10_000 });
		// an episode: drop → retry fires → still down → drop again …
		const fired: number[] = [];
		rc.onDrop();
		for (const _ of [500, 1000, 2000, 4000, 8000, 10_000, 10_000]) {
			const d = timers.fireNext();
			if (d === null) throw new Error("no retry scheduled");
			fired.push(d);
			rc.onDrop(); // the retry failed
		}
		expect(fired).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
		rc.onSuccess();
		rc.onDrop();
		expect(timers.fireNext()).toBe(500); // ladder restarted after a success
	});

	it("jitter bounds the delay to ±25%", () => {
		const low = new ReconnectController({ jitter: () => 0, onRetry: () => {} });
		const high = new ReconnectController({ jitter: () => 1, onRetry: () => {} });
		expect(low.nextDelay()).toBe(500 * 0.75);
		expect(high.nextDelay()).toBe(500 * 1.25);
	});

	it("success resets the ladder", () => {
		const { rc, timers } = makeController({ baseMs: 500 });
		rc.onDrop();
		timers.fireNext(); // retry 1 fired, failed
		rc.onDrop();
		rc.onSuccess();
		expect(timers.pending()).toBe(0);
		expect(rc.getAttempts()).toBe(0);
		expect(rc.getState()).toBe("connected");
		rc.onDrop();
		expect(timers.fireNext()).toBe(500); // ladder restarted from the base
	});

	it("each drop schedules exactly one retry, fired once", () => {
		const { rc, timers, retries } = makeController();
		rc.onDrop();
		expect(timers.pending()).toBe(1);
		expect(rc.getState()).toBe("reconnecting");
		expect(timers.fireNext()).toBe(500);
		expect(retries.length).toBe(1);
		rc.onDrop(); // retry failed again
		expect(timers.fireNext()).toBe(1000);
		expect(retries.length).toBe(2);
		expect(timers.pending()).toBe(0);
	});
});

describe("reconnect: visibility trigger (phone unlock)", () => {
	it("visible while down fires immediately, skipping the stale backoff", () => {
		const { rc, timers, retries } = makeController({ baseMs: 8000 });
		rc.onDrop();
		rc.onDrop();
		rc.onDrop(); // deep in the ladder — next retry would be 8s out
		rc.onVisible();
		expect(timers.pending()).toBe(1);
		expect(timers.fireNext()).toBe(0); // immediate
		expect(retries.length).toBe(1);
	});

	it("visibility starts a fresh backoff episode (the immediate retry is attempt #1)", () => {
		const { rc, timers } = makeController({ baseMs: 500 });
		rc.onDrop();
		rc.onDrop();
		rc.onDrop(); // attempts deep in the ladder
		rc.onVisible();
		timers.fireNext(); // immediate visibility retry — fails again
		rc.onDrop();
		expect(timers.fireNext()).toBe(1000); // attempt #2 of the fresh episode, not 4000
	});

	it("visible while connected is a no-op", () => {
		const { rc, timers, retries } = makeController();
		rc.onSuccess();
		rc.onVisible();
		expect(timers.pending()).toBe(0);
		expect(retries.length).toBe(0);
	});

	it("cancel stops retrying for good", () => {
		const { rc, timers, retries } = makeController();
		rc.onDrop();
		rc.cancel();
		expect(timers.pending()).toBe(0); // nothing fires; the owner drops its
		expect(retries.length).toBe(0); // visibility listener in the same teardown
	});
});

describe("reconnect: state machine", () => {
	it("first-ever connect is connecting, later drops are reconnecting", () => {
		const { rc, states } = makeController();
		expect(rc.getState()).toBe("connecting");
		rc.onSuccess();
		expect(rc.getState()).toBe("connected");
		rc.onDrop();
		expect(rc.getState()).toBe("reconnecting");
		rc.onSuccess();
		expect(rc.getState()).toBe("connected");
		expect(states).toEqual(["connected", "reconnecting", "connected"]);
	});
});

describe("resume: idempotent conversation merge", () => {
	const msg = (id: string, text: string) => ({ id, text });

	it("empty local state adopts the server history wholesale", () => {
		expect(mergeResume([], [msg("a", "1"), msg("b", "2")])).toEqual([msg("a", "1"), msg("b", "2")]);
	});

	it("server history replaces by id — completed replies never duplicate", () => {
		const local = [msg("a", "1"), msg("b", "partial…")];
		const history = [msg("a", "1"), msg("b", "partial… finished while away")];
		const merged = mergeResume(local, history);
		expect(merged).toEqual(history);
		expect(merged.filter((m) => m.id === "b").length).toBe(1);
	});

	it("local-only messages append in order (optimistic sends during the drop)", () => {
		const local = [msg("a", "1"), msg("x", "typed while offline")];
		const history = [msg("a", "1")];
		expect(mergeResume(local, history)).toEqual([msg("a", "1"), msg("x", "typed while offline")]);
	});
});

describe("resume: voice auto-resume policy", () => {
	it("resumes when the user armed the mic and nothing is live or booting", () => {
		expect(shouldAutoResumeVoice({ wasWanted: true, live: false, booting: false })).toBe(true);
	});

	it("stays down when the user explicitly stopped", () => {
		expect(shouldAutoResumeVoice({ wasWanted: false, live: false, booting: false })).toBe(false);
	});

	it("does nothing while a session or a boot attempt exists", () => {
		expect(shouldAutoResumeVoice({ wasWanted: true, live: true, booting: false })).toBe(false);
		expect(shouldAutoResumeVoice({ wasWanted: true, live: false, booting: true })).toBe(false);
	});
});
