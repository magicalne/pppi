// Voice mode tests (#53): parsing + labels + gating decisions.

package dev.pppi.omni

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceModeTest {
	@Test
	fun parsingRoundTripsTheThreeModes() {
		assertEquals(VoiceMode.ALWAYS, parseVoiceMode("always"))
		assertEquals(VoiceMode.PTT, parseVoiceMode("ptt"))
		// #53 keeps today's default; #54 flips it to OFF
		assertEquals(VoiceMode.ALWAYS, parseVoiceMode(null))
		assertEquals(VoiceMode.ALWAYS, parseVoiceMode("junk"))
	}

	@Test
	fun labelsAndHintsCoverEveryMode() {
		for (m in VoiceMode.entries) {
			assertTrue(voiceModeLabel(m).isNotBlank())
			assertTrue(voiceModeHint(m).isNotBlank())
		}
	}
}
