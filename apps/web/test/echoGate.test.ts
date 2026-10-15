import { describe, expect, it } from "vitest";
import { EchoGate } from "../src/voice/echoGate.ts";
import { MIC_CONSTRAINTS } from "../src/voice/mic.ts";

/** fake clock: t starts at 1000, advance() moves it */
function fakeClock() {
	let t = 1000;
	const now = () => t;
	const advance = (ms: number) => {
		t += ms;
	};
	return { now, advance };
}

describe("echo gate: idle → speaking → tail → idle", () => {
	it("gates while speaking, holds the tail, then opens", () => {
		const c = fakeClock();
		const gate = new EchoGate({ tailMs: 400, now: c.now });
		expect(gate.state).toBe("idle");
		expect(gate.isGated()).toBe(false);

		gate.beginPlayback();
		expect(gate.state).toBe("speaking");
		c.advance(200);
		gate.feedChunk(); // mid-reply refresh
		expect(gate.state).toBe("speaking");

		gate.playbackDrained();
		expect(gate.state).toBe("tail");
		c.advance(399);
		expect(gate.state).toBe("tail");
		c.advance(2);
		expect(gate.state).toBe("idle");
		expect(gate.isGated()).toBe(false);
	});

	it("a new utterance during the tail re-gates, and the tail re-arms from the new drain", () => {
		const c = fakeClock();
		const gate = new EchoGate({ tailMs: 400, now: c.now });
		gate.beginPlayback();
		gate.playbackDrained();
		c.advance(200); // mid-tail
		gate.beginPlayback(); // next sentence
		expect(gate.state).toBe("speaking");
		c.advance(300);
		gate.playbackDrained();
		expect(gate.state).toBe("tail"); // 400ms from the SECOND drain
		c.advance(399);
		expect(gate.state).toBe("tail");
		c.advance(2);
		expect(gate.state).toBe("idle");
	});

	it("a second drain re-arms the tail from the LATER audio (echo follows the speaker)", () => {
		const c = fakeClock();
		const gate = new EchoGate({ tailMs: 400, now: c.now });
		gate.beginPlayback();
		gate.playbackDrained(); // tail until t=1400
		c.advance(300); // t=1300, mid-tail
		gate.beginPlayback(); // next sentence plays 10ms more
		c.advance(10);
		gate.playbackDrained(); // audio until t=1310 → echo window to 1710
		c.advance(80); // t=1390
		expect(gate.state).toBe("tail"); // the first deadline alone would have opened — but audio played later
		c.advance(320); // t=1710
		expect(gate.state).toBe("idle");
	});
});

describe("echo gate: barge-in during gate (explicit interrupt)", () => {
	it("interrupt reopens the mic sooner than a natural drain tail", () => {
		const c = fakeClock();
		const gate = new EchoGate({ tailMs: 400, interruptTailMs: 250, now: c.now });
		gate.beginPlayback();
		c.advance(500);
		gate.interrupt(); // user tapped stop mid-sentence
		expect(gate.state).toBe("tail");
		c.advance(249);
		expect(gate.state).toBe("tail");
		c.advance(2);
		expect(gate.state).toBe("idle"); // mic live 150ms sooner than the 400ms tail
	});

	it("interrupt during the tail does not extend it beyond the natural deadline", () => {
		const c = fakeClock();
		const gate = new EchoGate({ tailMs: 400, interruptTailMs: 250, now: c.now });
		gate.beginPlayback();
		gate.playbackDrained(); // tail until t=1400
		c.advance(350); // t=1350, 50ms of natural tail left
		gate.interrupt();
		c.advance(49);
		expect(gate.state).toBe("tail");
		c.advance(2);
		expect(gate.state).toBe("idle"); // still the 1400 deadline — interrupt never extends
	});

	it("reset opens the mic immediately from any state", () => {
		const c = fakeClock();
		const gate = new EchoGate({ now: c.now });
		gate.beginPlayback();
		gate.reset();
		expect(gate.state).toBe("idle");
		expect(gate.isGated()).toBe(false);

		gate.beginPlayback();
		gate.playbackDrained();
		gate.reset();
		expect(gate.state).toBe("idle");
	});
});

describe("echo gate: lost tts_end must not brick the mic", () => {
	it("speaking with no chunks for stallMs self-drains into the tail", () => {
		const c = fakeClock();
		const gate = new EchoGate({ stallMs: 2500, tailMs: 400, now: c.now });
		gate.beginPlayback();
		c.advance(2499);
		expect(gate.state).toBe("speaking");
		c.advance(2);
		expect(gate.state).toBe("tail"); // self-drained, not stuck speaking
		c.advance(401);
		expect(gate.state).toBe("idle");
	});

	it("chunks keep a long reply alive well past stallMs", () => {
		const c = fakeClock();
		const gate = new EchoGate({ stallMs: 2500, now: c.now });
		gate.beginPlayback();
		for (let i = 0; i < 20; i++) {
			c.advance(1000);
			gate.feedChunk(); // a chunk every second for 20s
			expect(gate.state).toBe("speaking");
		}
	});
});

describe("mic capture constraints (issue #21 plumbing)", () => {
	it("requests platform AEC, noise suppression and AGC on mono capture", () => {
		expect(MIC_CONSTRAINTS).toMatchObject({
			channelCount: 1,
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
		});
	});
});
