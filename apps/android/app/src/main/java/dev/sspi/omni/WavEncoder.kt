package dev.sspi.omni

import java.io.ByteArrayOutputStream

/** Mono 16-bit PCM → 16 kHz PCM16 WAV bytes (what the sspi server's /api/voice expects). */
object WavEncoder {

	const val SAMPLE_RATE = 16000

	/** @param pcm chunked PCM16 samples (little-endian shorts), mono. */
	fun encode(chunks: List<ShortArray>, sampleRate: Int = SAMPLE_RATE): ByteArray {
		val totalSamples = chunks.sumOf { it.size }
		val dataSize = totalSamples * 2
		val out = ByteArrayOutputStream(44 + dataSize)

		// RIFF header
		out.write("RIFF".toByteArray(Charsets.US_ASCII))
		writeLe32(out, 36 + dataSize)
		out.write("WAVE".toByteArray(Charsets.US_ASCII))
		out.write("fmt ".toByteArray(Charsets.US_ASCII))
		writeLe32(out, 16)          // fmt chunk size
		writeLe16(out, 1)           // PCM
		writeLe16(out, 1)           // mono
		writeLe32(out, sampleRate)
		writeLe32(out, sampleRate * 2) // byte rate
		writeLe16(out, 2)           // block align
		writeLe16(out, 16)          // bits per sample
		out.write("data".toByteArray(Charsets.US_ASCII))
		writeLe32(out, dataSize)

		for (chunk in chunks) {
			for (s in chunk) {
				writeLe16(out, s.toInt() and 0xFFFF)
			}
		}
		return out.toByteArray()
	}

	private fun writeLe32(out: ByteArrayOutputStream, v: Int) {
		out.write(v and 0xFF)
		out.write((v shr 8) and 0xFF)
		out.write((v shr 16) and 0xFF)
		out.write((v shr 24) and 0xFF)
	}

	private fun writeLe16(out: ByteArrayOutputStream, v: Int) {
		out.write(v and 0xFF)
		out.write((v shr 8) and 0xFF)
	}
}
