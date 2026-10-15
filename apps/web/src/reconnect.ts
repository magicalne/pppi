/**
 * Reconnect controller — issue #22. Shared retry policy for the app's live
 * sockets (chat ws, voice ws): exponential backoff with jitter, an
 * immediate attempt when the page becomes visible again (the phone-unlock
 * case — timers were frozen while locked, the scheduled retry is stale),
 * and a state the UI can render instead of a dead app.
 *
 * Everything time-related is injectable so the policy unit tests without
 * real waiting. The controller never touches sockets: it schedules
 * `onRetry` and tracks how the connection is doing.
 */

export type ReconnectState = "connecting" | "connected" | "reconnecting";

export type ReconnectOpts = {
	/** first retry delay (default 500 ms) */
	baseMs?: number;
	/** backoff cap (default 10 s) */
	maxMs?: number;
	/** 0..1; delays jitter ±25% so fleets don't stampede (default Math.random) */
	jitter?: () => number;
	setTimeoutFn?: (fn: () => void, ms: number) => unknown;
	clearTimeoutFn?: (t: unknown) => void;
	onStateChange?: (state: ReconnectState) => void;
	/** the controller decided a retry is due — go (re)connect */
	onRetry: () => void;
};

type DefaultTimer = ReturnType<typeof setTimeout>;

export class ReconnectController {
	private readonly baseMs: number;
	private readonly maxMs: number;
	private readonly jitter: () => number;
	private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
	private readonly clearTimeoutFn: (t: unknown) => void;
	private readonly onStateChange?: (state: ReconnectState) => void;
	private readonly onRetry: () => void;

	private timer: unknown = null;
	private attempts = 0;
	private state: ReconnectState = "connecting";

	constructor(opts: ReconnectOpts) {
		this.baseMs = opts.baseMs ?? 500;
		this.maxMs = opts.maxMs ?? 10_000;
		this.jitter = opts.jitter ?? Math.random;
		this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as DefaultTimer);
		this.clearTimeoutFn = opts.clearTimeoutFn ?? ((t) => clearTimeout(t as DefaultTimer));
		this.onStateChange = opts.onStateChange;
		this.onRetry = opts.onRetry;
	}

	getState(): ReconnectState {
		return this.state;
	}

	getAttempts(): number {
		return this.attempts;
	}

	/** delay for the next scheduled retry (exponential with jitter, capped) */
	nextDelay(): number {
		const exp = Math.min(this.maxMs, this.baseMs * 2 ** this.attempts);
		return exp * (0.75 + 0.5 * this.jitter());
	}

	/** the socket opened/handshook — reset the ladder */
	onSuccess(): void {
		this.clearTimer();
		this.attempts = 0;
		this.setState("connected");
	}

	/** the socket dropped — schedule a retry with backoff */
	onDrop(): void {
		this.clearTimer();
		this.setState("reconnecting");
		this.armRetry();
	}

	/** page visible again — if we're down, retry NOW: the scheduled timer is
	 * stale after a freeze (phone unlock), and this starts a fresh backoff
	 * episode from the base delay. */
	onVisible(): void {
		if (this.state === "connected") return;
		this.clearTimer();
		this.attempts = 0;
		this.armRetry(0);
	}

	/** teardown — stop retrying for good */
	cancel(): void {
		this.clearTimer();
	}

	private armRetry(delayMs?: number): void {
		const delay = delayMs ?? Math.max(0, this.nextDelay());
		this.attempts++;
		this.timer = this.setTimeoutFn(() => {
			this.timer = null;
			this.onRetry();
		}, delay);
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			this.clearTimeoutFn(this.timer);
			this.timer = null;
		}
	}

	private setState(next: ReconnectState) {
		if (next === this.state) return;
		this.state = next;
		this.onStateChange?.(this.state);
	}
}

/**
 * Idempotent resume for the conversation view — issue #22 criterion 4.
 * The server's `hello_ok` history is the truth for every id it carries
 * (replaced wholesale: a message that finished server-side while we were
 * away arrives complete, never duplicated). Local messages the server
 * doesn't know (none today, but optimistic sends would land here) append
 * in their original order.
 */
export type ResumableMsg = { id: string };

export function mergeResume<T extends ResumableMsg>(current: T[], history: T[]): T[] {
	if (current.length === 0) return history;
	const seen = new Set(history.map((m) => m.id));
	const localOnly = current.filter((m) => !seen.has(m.id));
	return [...history, ...localOnly];
}

/**
 * Voice auto-resume policy — issue #22. The user armed the mic; the session
 * dropped (phone locked / app backgrounded) and in-foreground retries are
 * exhausted. When the page becomes visible again and nothing is live or
 * booting, the session should come back by itself — no manual tap.
 */
export function shouldAutoResumeVoice(input: {
	wasWanted: boolean;
	/** a live client exists */
	live: boolean;
	/** a (re)connect attempt is already in flight */
	booting: boolean;
}): boolean {
	return input.wasWanted && !input.live && !input.booting;
}
