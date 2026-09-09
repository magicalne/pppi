package dev.pppi.omni

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import androidx.core.content.ContextCompat
import kotlin.concurrent.thread
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Mic + speaker plumbing for interactive mode. The mic streams 16 kHz mono
 * PCM16 to the gateway with platform echo cancellation / noise suppression /
 * AGC attached; the speaker side streams TTS PCM into an AudioTrack and can
 * cut playback instantly on barge-in.
 *
 * Routing, in order of preference: Bluetooth headset mic (SCO via the
 * communication device), wired headset, then the phone's speaker+mic pair.
 * VOICE_COMMUNICATION input is unreliable without MODE_IN_COMMUNICATION on
 * several devices (and silent on emulators); if it still delivers digital
 * silence for ~1.5 s, capture falls back to the raw MIC source once.
 * Headset plug / SCO state changes mid-session re-route capture.
 */
class VoiceAudioEngine(
	private val context: Context,
	private val client: VoiceClient,
	private val audioManager: AudioManager,
	private val onMicLevel: (Int) -> Unit = {},
	private val onPlayLevel: (Int) -> Unit = {},
) {

	private val recordRef = AtomicReference<AudioRecord?>(null)
	private val keepRunning = AtomicBoolean(false)
	private val trackLock = Any()
	private var track: AudioTrack? = null
	private var trackRate = 24000
	private var commModeApplied = false
	private var scoRequested = false
	private var speakerphoneApplied = false
	private var receiverRegistered = false
	private var appliedRoute = ""
	private var rerouting = AtomicBoolean(false)
	private var lastPlayLevelAt = 0L

	/** "bt" | "wired" | "speaker" — where capture is (supposed to be) coming from. */
	private fun routeKey(): String {
		val inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
		var key = "speaker"
		for (d in inputs) {
			if (d.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || d.type == AudioDeviceInfo.TYPE_USB_HEADSET) key = "wired"
		}
		for (d in inputs) {
			if (d.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO && hasBluetoothPermission()) key = "bt"
		}
		return key
	}

	private val deviceListener = object : BroadcastReceiver() {
		override fun onReceive(c: Context?, i: Intent?) {
			if (!keepRunning.get()) return
			if (rerouting.compareAndSet(false, true)) {
				thread(name = "pppi-reroute") {
					try { reroute() } finally { rerouting.set(false) }
				}
			}
		}
	}

	fun startMic(onError: (String) -> Unit) {
		if (!keepRunning.compareAndSet(false, true)) return
		try {
			commModeApplied = true
			audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
			audioManager.isMicrophoneMute = false
			appliedRoute = applyRoute(onError)
			val filter = IntentFilter().apply {
				addAction(AudioManager.ACTION_HEADSET_PLUG)
				addAction(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
			}
			ContextCompat.registerReceiver(context, deviceListener, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
			receiverRegistered = true
			spawnReader(onError)
		} catch (e: Exception) {
			keepRunning.set(false)
			restoreAudioMode()
			onError(e.message ?: "microphone unavailable")
		}
	}

	private fun spawnReader(onError: (String) -> Unit) {
		thread(name = "pppi-mic") {
			val buf = ShortArray(1600) // 100 ms @ 16 kHz
			val bytes = ByteArray(1600 * 2)
			var silentChunks = 0
			var source = MediaRecorder.AudioSource.VOICE_COMMUNICATION
			var lastSentLevel = -1
			try {
				openRecorder(source, onError, fatal = true)
				while (keepRunning.get()) {
					val rec = recordRef.get()
					if (rec == null) {
						Thread.sleep(20) // mid-reroute gap — wait for the new recorder
						continue
					}
					val n = rec.read(buf, 0, buf.size)
					if (n <= 0) continue
					var max = 0
					for (i in 0 until n) {
						val v = if (buf[i] < 0) -buf[i].toInt() else buf[i].toInt()
						if (v > max) max = v
						bytes[i * 2] = (buf[i].toInt() and 0xFF).toByte()
						bytes[i * 2 + 1] = (buf[i].toInt() shr 8).toByte()
					}
					// feed the soundwave: peak 0..32767 → 0..100
					val lvl = (max * 95 / 32767).coerceIn(0, 100)
					if (lvl != lastSentLevel) {
						lastSentLevel = lvl
						onMicLevel(lvl)
					}
					// dead comm mic: bit-exact silence for ~1.5 s → retry with raw MIC
					if (max <= 1 && source == MediaRecorder.AudioSource.VOICE_COMMUNICATION) {
						silentChunks++
						if (silentChunks >= 15) {
							silentChunks = 0
							source = MediaRecorder.AudioSource.MIC
							onError("no signal on voice mic — fell back to the phone mic")
							openRecorder(source, onError)
						}
					} else {
						silentChunks = 0
					}
					if (keepRunning.get()) client.sendAudio(bytes.copyOf(n * 2))
				}
			} catch (_: Exception) {
				if (keepRunning.get()) onError("microphone error")
			} finally {
				closeRecorder()
			}
		}
	}

	private fun openRecorder(source: Int, onError: (String) -> Unit, fatal: Boolean = false) {
		closeRecorder()
		val minBuf = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
		val rec = AudioRecord(
			source,
			16000,
			AudioFormat.CHANNEL_IN_MONO,
			AudioFormat.ENCODING_PCM_16BIT,
			maxOf(minBuf * 2, 32000 * 2),
		)
		if (rec.state != AudioRecord.STATE_INITIALIZED) {
			rec.release()
			if (fatal) keepRunning.set(false)
			if (keepRunning.get()) onError("microphone unavailable")
			return
		}
		rec.startRecording()
		recordRef.set(rec)
	}

	/** Idempotent + thread-safe: safe to call from both the reader and stop(). */
	private fun closeRecorder() {
		recordRef.getAndSet(null)?.let { r ->
			try {
				if (r.state == AudioRecord.STATE_INITIALIZED) r.stop()
			} catch (_: Exception) {
			}
			try {
				r.release()
			} catch (_: Exception) {
			}
		}
	}

	/**
	 * Pick output/input routing for the current headset situation; returns the
	 * *effective* route (a desired "bt" that failed reports "speaker", so the
	 * SCO-connected broadcast still counts as a change and triggers a reroute).
	 */
	private fun applyRoute(onError: (String) -> Unit): String {
		scoRequested = false
		speakerphoneApplied = false
		return when (routeKey()) {
			"bt" -> {
				val ok = if (Build.VERSION.SDK_INT >= 31) establishScoModern() else establishScoLegacy()
				if (!ok) {
					// SCO didn't land yet — speak through the speaker; the SCO broadcast
					// will trigger a reroute once the link comes up
					audioManager.isSpeakerphoneOn = true
					speakerphoneApplied = true
					onError("bluetooth mic not ready — using the phone mic for now")
					"speaker"
				} else "bt"
			}
			"speaker" -> {
				audioManager.isSpeakerphoneOn = true
				speakerphoneApplied = true
				"speaker"
			}
			// wired: the OS routes input/output to the headset on its own
			else -> "wired"
		}
	}

	/** API 31+: select the BT headset as the communication device (sets up SCO itself). */
	private fun establishScoModern(): Boolean {
		val sco = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
			.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
		if (sco != null) {
			return try {
				audioManager.setCommunicationDevice(sco)
				scoRequested = true
				true
			} catch (_: Exception) {
				false
			}
		}
		// SCO link not up yet — nudge it and wait for the input device to appear
		return try {
			audioManager.startBluetoothSco()
			val deadline = SystemClock.uptimeMillis() + SCO_WAIT_MS
			while (SystemClock.uptimeMillis() < deadline && keepRunning.get()) {
				val d = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
					.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
				if (d != null) {
					audioManager.setCommunicationDevice(d)
					scoRequested = true
					return true
				}
				Thread.sleep(150)
			}
			audioManager.stopBluetoothSco()
			false
		} catch (_: Exception) {
			false
		}
	}

	private fun establishScoLegacy(): Boolean {
		return try {
			audioManager.startBluetoothSco()
			audioManager.isBluetoothScoOn = true
			scoRequested = true
			val deadline = SystemClock.uptimeMillis() + SCO_WAIT_MS
			while (SystemClock.uptimeMillis() < deadline && keepRunning.get()) {
				val up = audioManager.isBluetoothScoOn &&
					audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
						.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
				if (up) return true
				Thread.sleep(150)
			}
			// leave scoRequested set: the SCO broadcast can still land and reroute us
			audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
				.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
		} catch (_: Exception) {
			false
		}
	}

	/** Headset plugged/unplugged or SCO state flipped mid-session → re-route capture. */
	private fun reroute() {
		val key = routeKey()
		synchronized(this) {
			if (key == appliedRoute) return
			appliedRoute = applyRoute { }
		}
		// fresh recorder so the new route takes effect immediately
		if (keepRunning.get()) openRecorder(MediaRecorder.AudioSource.VOICE_COMMUNICATION, onError = { })
	}

	private fun hasBluetoothPermission(): Boolean {
		return Build.VERSION.SDK_INT < 31 ||
			ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) ==
			PackageManager.PERMISSION_GRANTED
	}

	/** Stream TTS PCM (s16le at `rate`) into the speaker. Called per binary frame. */
	fun playPcm(pcm: ByteArray, rate: Int) {
		try {
			synchronized(trackLock) {
				if (!keepRunning.get()) return
				val t = ensureTrackLocked(rate)
				t.write(pcm, 0, pcm.size)
			}
			// feed the soundwave while the agent speaks (~12 updates/s is plenty)
			val now = SystemClock.uptimeMillis()
			if (now - lastPlayLevelAt >= 80) {
				lastPlayLevelAt = now
				var peak = 0
				var i = 0
				while (i + 1 < pcm.size) {
					var v = (pcm[i].toInt() and 0xFF) or (pcm[i + 1].toInt() shl 8)
					if (v >= 32768) v -= 65536
					if (v < 0) v = -v
					if (v > peak) peak = v
					i += 2
				}
				onPlayLevel((peak * 95 / 32767).coerceIn(0, 100))
			}
		} catch (_: Exception) {
			// track raced with stop() — drop the frame
		}
	}

	/** Barge-in: cut local playback immediately. */
	fun stopPlayback() {
		synchronized(trackLock) {
			track?.let {
				try {
					it.pause()
					it.flush()
				} catch (_: Exception) {
				}
			}
		}
	}

	fun stop() {
		keepRunning.set(false)
		closeRecorder()
		synchronized(trackLock) {
			track?.let {
				try {
					it.stop()
					it.release()
				} catch (_: Exception) {
					// already released
				}
			}
			track = null
		}
		if (receiverRegistered) {
			receiverRegistered = false
			try {
				context.unregisterReceiver(deviceListener)
			} catch (_: Exception) {
			}
		}
		restoreAudioMode()
	}

	private fun restoreAudioMode() {
		if (scoRequested) {
			scoRequested = false
			try {
				audioManager.stopBluetoothSco()
				audioManager.isBluetoothScoOn = false
			} catch (_: Exception) {
			}
		}
		if (speakerphoneApplied) {
			speakerphoneApplied = false
			try {
				audioManager.isSpeakerphoneOn = false
			} catch (_: Exception) {
			}
		}
		if (commModeApplied) {
			commModeApplied = false
			try {
				audioManager.mode = AudioManager.MODE_NORMAL
			} catch (_: Exception) {
			}
		}
	}

	private fun ensureTrackLocked(rate: Int): AudioTrack {
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

	private companion object {
		const val SCO_WAIT_MS = 2500L
	}
}
