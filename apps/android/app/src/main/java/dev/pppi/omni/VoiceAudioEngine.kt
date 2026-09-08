package dev.pppi.omni

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Mic + speaker plumbing for interactive mode. The mic streams 16 kHz mono
 * PCM16 to the gateway with platform echo cancellation / noise suppression /
 * AGC attached; the speaker side streams TTS PCM into an AudioTrack and can
 * cut playback instantly on barge-in.
 *
 * The audio manager is put in MODE_IN_COMMUNICATION + speakerphone for the
 * session — VOICE_COMMUNICATION input is unreliable without it on several
 * devices (and silent on emulators). If the comm mic still delivers digital
 * silence for ~1.5 s, capture falls back to the raw MIC source once.
 */
class VoiceAudioEngine(
	private val client: VoiceClient,
	private val audioManager: AudioManager,
) {

	private var record: AudioRecord? = null
	private val keepRunning = AtomicBoolean(false)
	private var track: AudioTrack? = null
	private var trackRate = 24000
	private var commModeApplied = false

	private fun buildRecorder(source: Int): AudioRecord {
		val minBuf = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
		return AudioRecord(
			source,
			16000,
			AudioFormat.CHANNEL_IN_MONO,
			AudioFormat.ENCODING_PCM_16BIT,
			maxOf(minBuf * 2, 32000 * 2),
		)
	}

	fun startMic(onError: (String) -> Unit) {
		if (keepRunning.get()) return
		keepRunning.set(true)
		try {
			commModeApplied = true
			audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
			audioManager.isSpeakerphoneOn = true
			var source = MediaRecorder.AudioSource.VOICE_COMMUNICATION
			val rec = buildRecorder(source)
			record = rec
			rec.startRecording()
			Thread {
				val buf = ShortArray(1600) // 100 ms @ 16 kHz
				val bytes = ByteArray(1600 * 2)
				var silentChunks = 0
				while (keepRunning.get()) {
					val n = rec.read(buf, 0, buf.size)
					if (n > 0) {
						var max = 0
						for (i in 0 until n) {
							val v = if (buf[i] < 0) -buf[i].toInt() else buf[i].toInt()
							if (v > max) max = v
							bytes[i * 2] = (buf[i].toInt() and 0xFF).toByte()
							bytes[i * 2 + 1] = (buf[i].toInt() shr 8).toByte()
						}
						// dead comm mic: bit-exact silence for ~1.5 s → retry with raw MIC
						if (max <= 1 && source == MediaRecorder.AudioSource.VOICE_COMMUNICATION) {
							silentChunks++
							if (silentChunks >= 15) {
								silentChunks = 0
								source = MediaRecorder.AudioSource.MIC
								onError("no signal on voice mic — fell back to raw mic")
								rec.stop()
								rec.release()
								val fallback = buildRecorder(source)
								record = fallback
								fallback.startRecording()
								continue
							}
						} else {
							silentChunks = 0
						}
						client.sendAudio(bytes.copyOf(n * 2))
					}
				}
				rec.stop()
				rec.release()
			}.start()
		} catch (e: Exception) {
			keepRunning.set(false)
			onError(e.message ?: "microphone unavailable")
		}
	}

	/** Stream TTS PCM (s16le at `rate`) into the speaker. Called per binary frame. */
	@Synchronized fun playPcm(pcm: ByteArray, rate: Int) {
		val t = ensureTrack(rate)
		t.write(pcm, 0, pcm.size)
	}

	/** Barge-in: cut local playback immediately. */
	@Synchronized fun stopPlayback() {
		track?.let {
			it.pause()
			it.flush()
		}
	}

	fun stop() {
		keepRunning.set(false)
		stopPlayback()
		try {
			track?.stop()
			track?.release()
		} catch (_: Exception) {
			// already released
		}
		track = null
		if (commModeApplied) {
			commModeApplied = false
			audioManager.isSpeakerphoneOn = false
			audioManager.mode = AudioManager.MODE_NORMAL
		}
	}

	private fun ensureTrack(rate: Int): AudioTrack {
		track?.let { existing ->
			if (trackRate == rate) return existing
			existing.stop()
			existing.release()
		}
		trackRate = rate
		val minBuf = AudioTrack.getMinBufferSize(
			rate,
			AudioFormat.CHANNEL_OUT_MONO,
			AudioFormat.ENCODING_PCM_16BIT,
		)
		val track = AudioTrack(
			AudioAttributes.Builder()
				.setUsage(AudioAttributes.USAGE_MEDIA)
				.setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
				.build(),
			AudioFormat.Builder()
				.setEncoding(AudioFormat.ENCODING_PCM_16BIT)
				.setSampleRate(rate)
				.setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
				.build(),
			maxOf(minBuf * 2, rate * 2), // ≥ 1 s of buffer
			AudioTrack.MODE_STREAM,
			AudioManager.AUDIO_SESSION_ID_GENERATE,
		)
		track.play()
		this.track = track
		return track
	}
}
