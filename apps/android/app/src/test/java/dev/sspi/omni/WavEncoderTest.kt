package dev.sspi.omni

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WavEncoderTest {

	@Test
	fun `encodes a valid 16k mono pcm16 wav`() {
		val wav = WavEncoder.encode(listOf(shortArrayOf(0, 16383, -16383, 32767, -32768)))
		assertEquals(44 + 5 * 2, wav.size)

		val ascii = { off: Int, n: Int -> String(wav.copyOfRange(off, off + n), Charsets.US_ASCII) }
		assertEquals("RIFF", ascii(0, 4))
		assertEquals("WAVE", ascii(8, 4))
		assertEquals("fmt ", ascii(12, 4))
		assertEquals("data", ascii(36, 4))

		val le16 = { off: Int -> ((wav[off].toInt() and 0xFF) or ((wav[off + 1].toInt() and 0xFF) shl 8)) }
		val le32 = { off: Int -> le16(off) or (le16(off + 2) shl 16) }
		assertEquals(36 + 10, le32(4))          // riff size
		assertEquals(1, le16(20))               // PCM
		assertEquals(1, le16(22))               // mono
		assertEquals(16000, le32(24))           // sample rate
		assertEquals(32000, le32(28))           // byte rate
		assertEquals(16, le16(34))              // bits
		assertEquals(10, le32(40))              // data size

		// little-endian samples
		assertEquals(0, le16(44))
		assertEquals(16383, le16(46))
		assertEquals(-16383, le16(48).toShort().toInt())
	}

	@Test
	fun `concatenates chunks in order`() {
		val wav = WavEncoder.encode(listOf(shortArrayOf(100, 200), shortArrayOf(300)))
		assertEquals(44 + 6, wav.size)
		val sample = { i: Int -> ((wav[44 + i * 2].toInt() and 0xFF) or ((wav[44 + i * 2 + 1].toInt() and 0xFF) shl 8)).toShort().toInt() }
		assertEquals(100, sample(0))
		assertEquals(200, sample(1))
		assertEquals(300, sample(2))
	}

	@Test
	fun `empty input still produces a header-only wav`() {
		val wav = WavEncoder.encode(emptyList())
		assertEquals(44, wav.size)
		assertTrue(wav.copyOfRange(0, 4).contentEquals("RIFF".toByteArray()))
	}
}
