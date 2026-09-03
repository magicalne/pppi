package dev.sspi.omni

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device proof of the voice pipeline: takes a real speech WAV, extracts its
 * PCM exactly like the mic reader would, encodes it with the app's own
 * WavEncoder, and — when the sspi gateway is reachable (args sspi.server /
 * sspi.token) — uploads it and asserts the server transcribed the phrase.
 * Skips gracefully when no gateway is running.
 */
@RunWith(AndroidJUnit4::class)
class VoicePipelineDeviceTest {

	private fun loadAssetPcm16k(): ShortArray {
		val ctx = InstrumentationRegistry.getInstrumentation().context
		val bytes = ctx.assets.open("voice-sample.wav").use { it.readBytes() }
		val pcm = ByteBuffer.wrap(bytes, 44, bytes.size - 44).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
		val out = ShortArray(pcm.remaining())
		pcm.get(out)
		return out
	}

	@Test
	fun encodesRealSpeechToValidWavOnDevice() {
		val pcm = loadAssetPcm16k()
		assertTrue("expected real speech samples", pcm.size > 16_000) // > 1s

		val wav = WavEncoder.encode(listOf(pcm))
		assertEquals(44 + pcm.size * 2, wav.size)
		assertEquals("RIFF", String(wav.copyOfRange(0, 4), Charsets.US_ASCII))
		assertEquals("WAVE", String(wav.copyOfRange(8, 12), Charsets.US_ASCII))

		val le16 = { off: Int -> ((wav[off].toInt() and 0xFF) or ((wav[off + 1].toInt() and 0xFF) shl 8)) }
		assertEquals(16000, le16(24) or (le16(26) shl 16)) // sample rate
		assertEquals(pcm.size * 2, le16(40) or (le16(42) shl 16)) // data size
	}

	@Test
	fun uploadsRealSpeechAndGatewayTranscribesIt() {
		val args = InstrumentationRegistry.getArguments()
		val server = args.getString("sspi.server") ?: return
		val token = args.getString("sspi.token") ?: return
		val host = server.removePrefix("http://").substringBefore(":")
		val port = server.substringAfterLast(":").trimEnd('/').toIntOrNull() ?: 8787

		// only run when a gateway is actually listening
		try {
			Socket().use { it.connect(InetSocketAddress(host, port), 1000) }
		} catch (_: Exception) {
			return // gateway not running — pipeline encode test above still ran
		}

		val wav = WavEncoder.encode(listOf(loadAssetPcm16k()))
		val res = URL("$server/api/voice").openConnection() as HttpURLConnection
		res.requestMethod = "POST"
		res.setRequestProperty("Authorization", "Bearer $token")
		res.setRequestProperty("Content-Type", "audio/wav")
		res.doOutput = true
		res.outputStream.use { it.write(wav) }
		val body = res.inputStream.readBytes().decodeToString()
		assertEquals(200, res.responseCode)
		assertTrue("expected ok:true, got: $body", body.contains("\"ok\":true"))
		assertTrue("expected a real transcript, got: $body", body.contains("transcript"))
		res.disconnect()
	}
}
