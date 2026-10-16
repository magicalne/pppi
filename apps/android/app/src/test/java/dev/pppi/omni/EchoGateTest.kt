// EchoGate parity tests — mirrors apps/web/test/echoGate.test.ts case for
// case (fake clock, same timings) so the Android port cannot drift from the
// TS state machine. JVM-only: the gate's default clock is SystemClock, but
// every test injects a fake.

package dev.pppi.omni

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** fake clock: t starts at 1000, advance() moves it */
private class FakeClock {
	var t = 1000L
	val now: () -> Long = { t }
	fun advance(ms: Long) {
		t += ms
	}
}

class EchoGateTest {
	// ------------------------------ idle → speaking → tail → idle

	@Test
	fun gatesWhileSpeakingHoldsTheTailThenOpens() {
		val c = FakeClock()
		val gate = EchoGate(tailMs = 400, now = c.now)
		assertEquals("idle", gate.state)
		assertFalse(gate.isGated())

		gate.beginPlayback()
		assertEquals("speaking", gate.state)
		c.advance(200)
		gate.feedChunk() // mid-reply refresh
		assertEquals("speaking", gate.state)

		gate.playbackDrained()
		assertEquals("tail", gate.state)
		c.advance(399)
		assertEquals("tail", gate.state)
		c.advance(2)
		assertEquals("idle", gate.state)
		assertFalse(gate.isGated())
	}

	@Test
	fun newUtteranceDuringTailReGatesAndTailReArmsFromNewDrain() {
		val c = FakeClock()
		val gate = EchoGate(tailMs = 400, now = c.now)
		gate.beginPlayback()
		gate.playbackDrained()
		c.advance(200) // mid-tail
		gate.beginPlayback() // next sentence
		assertEquals("speaking", gate.state)
		c.advance(300)
		gate.playbackDrained()
		assertEquals("tail", gate.state) // 400ms from the SECOND drain
		c.advance(399)
		assertEquals("tail", gate.state)
		c.advance(2)
		assertEquals("idle", gate.state)
	}

	@Test
	fun secondDrainRearmsTailFromTheLaterAudio() {
		val c = FakeClock()
		val gate = EchoGate(tailMs = 400, now = c.now)
		gate.beginPlayback()
		gate.playbackDrained() // tail until t=1400
		c.advance(300) // t=1300, mid-tail
		gate.beginPlayback() // next sentence plays 10ms more
		c.advance(10)
		gate.playbackDrained() // audio until t=1310 → echo window to 1710
		c.advance(80) // t=1390
		assertEquals("tail", gate.state) // first deadline alone would have opened — but audio played later
		c.advance(320) // t=1710
		assertEquals("idle", gate.state)
	}

	// ------------------------------ barge-in during gate (explicit interrupt)

	@Test
	fun interruptReopensTheMicSoonerThanNaturalDrainTail() {
		val c = FakeClock()
		val gate = EchoGate(tailMs = 400, interruptTailMs = 250, now = c.now)
		gate.beginPlayback()
		c.advance(500)
		gate.interrupt() // user tapped stop mid-sentence
		assertEquals("tail", gate.state)
		c.advance(249)
		assertEquals("tail", gate.state)
		c.advance(2)
		assertEquals("idle", gate.state) // mic live 150ms sooner than the 400ms tail
	}

	@Test
	fun interruptDuringTailDoesNotExtendBeyondNaturalDeadline() {
		val c = FakeClock()
		val gate = EchoGate(tailMs = 400, interruptTailMs = 250, now = c.now)
		gate.beginPlayback()
		gate.playbackDrained() // tail until t=1400
		c.advance(350) // t=1350, 50ms of natural tail left
		gate.interrupt()
		c.advance(49)
		assertEquals("tail", gate.state)
		c.advance(2)
		assertEquals("idle", gate.state) // still the 1400 deadline — interrupt never extends
	}

	@Test
	fun resetOpensTheMicImmediatelyFromAnyState() {
		val c = FakeClock()
		val gate = EchoGate(now = c.now)
		gate.beginPlayback()
		gate.reset()
		assertEquals("idle", gate.state)
		assertFalse(gate.isGated())

		gate.beginPlayback()
		gate.playbackDrained()
		gate.reset()
		assertEquals("idle", gate.state)
	}

	// ------------------------------ lost tts_end must not brick the mic

	@Test
	fun speakingWithNoChunksForStallMsSelfDrainsIntoTheTail() {
		val c = FakeClock()
		val gate = EchoGate(stallMs = 2500, tailMs = 400, now = c.now)
		gate.beginPlayback()
		c.advance(2499)
		assertEquals("speaking", gate.state)
		c.advance(2)
		assertEquals("tail", gate.state) // self-drained, not stuck speaking
		c.advance(401)
		assertEquals("idle", gate.state)
	}

	@Test
	fun chunksKeepALongReplyAliveWellPastStallMs() {
		val c = FakeClock()
		val gate = EchoGate(stallMs = 2500, now = c.now)
		gate.beginPlayback()
		repeat(20) {
			c.advance(1000)
			gate.feedChunk() // a chunk every second for 20s
			assertEquals("speaking", gate.state)
		}
		assertTrue(gate.isGated())
	}
}
