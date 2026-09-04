package dev.sspi.omni

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceProtocolTest {

	@Test fun `parses all voice server events`() {
		val cases = listOf(
			"""{"type":"voice_hello_ok","stt":{"ready":true,"modelId":"parakeet"},"tts":{"ready":true,"provider":"kokoro","voice":"af_heart"}}"""
				to VoiceServerEvent.VoiceHelloOk::class,
			"""{"type":"voice_hello_fail","error":"bad pairing token"}""" to VoiceServerEvent.VoiceHelloFail::class,
			"""{"type":"voice_state","state":"speaking"}""" to VoiceServerEvent.VoiceState::class,
			"""{"type":"vad","speaking":true}""" to VoiceServerEvent.Vad::class,
			"""{"type":"stt_partial","committed":"hello","tentative":"wor"}""" to VoiceServerEvent.SttPartial::class,
			"""{"type":"stt_final","id":"abc","text":"hello there"}""" to VoiceServerEvent.SttFinal::class,
			"""{"type":"tts_start","id":"abc","rate":24000}""" to VoiceServerEvent.TtsStart::class,
			"""{"type":"tts_end","id":"abc","interrupted":true}""" to VoiceServerEvent.TtsEnd::class,
			"""{"type":"voice_error","message":"stt failed"}""" to VoiceServerEvent.VoiceError::class,
		)
		for ((json, expected) in cases) {
			val evt = protocolJson.decodeFromString(VoiceServerEvent.serializer(), json)
			assertEquals(expected, evt::class)
		}
	}

	@Test fun `partial defaults survive a minimal frame`() {
		val evt = protocolJson.decodeFromString(
			VoiceServerEvent.serializer(),
			"""{"type":"stt_partial"}""",
		) as VoiceServerEvent.SttPartial
		assertEquals("", evt.committed)
		assertEquals("", evt.tentative)
	}

	@Test fun `interrupted flag defaults to false`() {
		val evt = protocolJson.decodeFromString(
			VoiceServerEvent.serializer(),
			"""{"type":"tts_end","id":"x"}""",
		) as VoiceServerEvent.TtsEnd
		assertFalse(evt.interrupted)
	}

	@Test fun `client message json has the wire shape`() {
		assertEquals(
			"""{"type":"hello","token":"t0","client":"android"}""",
			VoiceClientMessages.hello("t0"),
		)
		assertEquals("""{"type":"interrupt"}""", VoiceClientMessages.interrupt())
		assertEquals("""{"type":"playback_done"}""", VoiceClientMessages.playbackDone())
	}

	@Test fun `phase machine mirrors the web state machine`() {
		val m = VoicePhaseMachine()
		assertEquals(VoicePhase.LISTENING, m.phase)

		// the user starts talking (not a barge-in — nothing is playing)
		assertFalse(m.onVad(true))
		assertEquals(VoicePhase.USER_SPEAKING, m.phase)
		// speech ends
		assertFalse(m.onVad(false))
		assertEquals(VoicePhase.LISTENING, m.phase)

		// server moves to thinking → speaking; user talks over the agent
		m.onServerState("thinking")
		assertEquals(VoicePhase.THINKING, m.phase)
		m.onServerState("speaking")
		assertEquals(VoicePhase.AGENT_SPEAKING, m.phase)
		assertTrue(m.onVad(true)) // barge-in: stop local playback
		assertEquals(VoicePhase.USER_SPEAKING, m.phase)
		assertFalse(m.stopPlayback) // one-shot flag, already consumed

		// vad false during playback must NOT relax the agent-speaking state
		m.onServerState("speaking")
		m.onVad(false)
		assertEquals(VoicePhase.AGENT_SPEAKING, m.phase)

		m.reset()
		assertEquals(VoicePhase.LISTENING, m.phase)
	}
}
