import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Screen Wake Lock controller — issue #18.
 *
 * Keeps the phone screen awake while the client is "live": voice mode on,
 * a boot in progress, or a task/stream producing output — plus an opt-in
 * "Keep screen on" toggle persisted in localStorage. Browsers drop the lock
 * when the tab hides, so the owner re-acquires on visibilitychange→visible.
 * Where the API is missing (iOS Safari, older browsers) everything is a
 * graceful no-op. The controller is DOM-free by default-injection so it unit
 * tests cleanly in node; the React hook wires the real navigator/document.
 */

export type WakeLockSentinelLike = {
	released: boolean;
	release(): Promise<void>;
	addEventListener(type: "release", listener: () => void): void;
};

export type WakeLockLike = {
	request(type: "screen"): Promise<WakeLockSentinelLike>;
};

export type WakeLockState = "unsupported" | "unlocked" | "locked" | "denied";

export const WAKE_LOCK_KEY = "pppi.wakelock";

export type WakeLockControllerOpts = {
	/** lazy resolver so the controller can be constructed before navigator exists */
	wakeLock?: () => WakeLockLike | undefined;
	storage?: Pick<Storage, "getItem" | "setItem">;
	/** used to decide whether a surprise release (tab was hidden) should re-acquire */
	isVisible?: () => boolean;
	onStateChange?: (state: WakeLockState) => void;
};

export type WakeLockController = {
	/** app activity (voice on / streaming); acquires or releases to match */
	update(active: boolean): void;
	/** user "Keep screen on" preference; persists immediately */
	setToggle(enabled: boolean): void;
	getToggle(): boolean;
	/** call on visibilitychange→visible: browsers release the lock while hidden */
	onVisible(): void;
	getState(): WakeLockState;
	/** release and stop; the browser also drops locks on page unload */
	destroy(): void;
};

const noopStorage: Pick<Storage, "getItem" | "setItem"> = {
	getItem: () => null,
	setItem: () => {},
};

function defaultWakeLock(): WakeLockLike | undefined {
	if (typeof navigator === "undefined") return undefined;
	return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
}

function defaultVisible(): boolean {
	if (typeof document === "undefined") return true;
	return document.visibilityState === "visible";
}

export function createWakeLockController(opts: WakeLockControllerOpts = {}): WakeLockController {
	const wakeLock = opts.wakeLock ?? defaultWakeLock;
	const storage = opts.storage ?? (typeof localStorage === "undefined" ? noopStorage : localStorage);
	const isVisible = opts.isVisible ?? defaultVisible;

	let active = false;
	let toggle = storage.getItem(WAKE_LOCK_KEY) === "1";
	let sentinel: WakeLockSentinelLike | null = null;
	let pending = false;
	let state: WakeLockState = "unlocked";

	const setState = (next: WakeLockState) => {
		if (next === state) return;
		state = next;
		opts.onStateChange?.(state);
	};

	const wants = () => active || toggle;

	async function releaseHeld() {
		const held = sentinel;
		sentinel = null;
		if (held && !held.released) {
			try {
				await held.release();
			} catch {
				// the UA already dropped it — nothing to do
			}
		}
	}

	async function reconcile() {
		if (!wants()) {
			await releaseHeld();
			setState("unlocked");
			return;
		}
		if (sentinel || pending) return;
		const wl = wakeLock();
		if (!wl) {
			setState("unsupported");
			return;
		}
		pending = true;
		try {
			const s = await wl.request("screen");
			if (!wants()) {
				// went idle while the request was in flight — don't hold the lock
				if (!s.released) await s.release().catch(() => {});
				setState("unlocked");
				return;
			}
			sentinel = s;
			s.addEventListener("release", onRelease);
			setState("locked");
		} catch (err) {
			// NotAllowedError: permission/policy denied; anything else — quiet no-op
			setState(err instanceof Error && err.name === "NotAllowedError" ? "denied" : "unlocked");
		} finally {
			pending = false;
		}
	}

	function onRelease() {
		// the UA released us (tab hidden, preemption, or our own release())
		if (!sentinel) return;
		sentinel = null;
		setState("unlocked");
		if (wants() && isVisible()) void reconcile();
	}

	return {
		update(next) {
			// no short-circuit: the hook's mount effect must reconcile a persisted
			// toggle-on even when active was already false (reconcile is guarded/no-op)
			active = next;
			void reconcile();
		},
		setToggle(enabled) {
			toggle = enabled;
			try {
				storage.setItem(WAKE_LOCK_KEY, enabled ? "1" : "0");
			} catch {
				// private-mode storage failures must not break the app
			}
			void reconcile();
		},
		getToggle: () => toggle,
		onVisible() {
			if (wants() && !sentinel) void reconcile();
		},
		getState: () => state,
		destroy() {
			active = false;
			toggle = false;
			void releaseHeld();
			setState("unlocked");
		},
	};
}

// ---------------------------------------------------------------- react wiring

export type UseWakeLock = {
	toggle: boolean;
	setToggle: (enabled: boolean) => void;
	state: WakeLockState;
};

/**
 * Owns one controller for the app's lifetime and feeds it:
 *  - `active` — voice on / boot / busy stream (recomputed every render)
 *  - visibilitychange → onVisible() for re-acquire after app switches
 */
export function useWakeLock(active: boolean): UseWakeLock {
	const [toggle, setToggleState] = useState<boolean>(() => {
		try {
			return localStorage.getItem(WAKE_LOCK_KEY) === "1";
		} catch {
			return false;
		}
	});
	const [state, setState] = useState<WakeLockState>("unlocked");
	const ctlRef = useRef<WakeLockController | null>(null);
	if (ctlRef.current === null) {
		ctlRef.current = createWakeLockController({ onStateChange: setState });
	}
	const ctl = ctlRef.current;

	const setToggle = useCallback(
		(enabled: boolean) => {
			setToggleState(enabled);
			ctl.setToggle(enabled);
		},
		[ctl],
	);

	useEffect(() => {
		ctl.update(active);
	}, [active, ctl]);

	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState === "visible") ctl.onVisible();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [ctl]);

	useEffect(() => {
		return () => {
			ctl.destroy();
		};
	}, [ctl]);

	return { toggle, setToggle, state };
}
