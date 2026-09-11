package dev.pppi.omni

import android.content.Context
import android.os.SystemClock
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * On-device telemetry for the voice path — the counterpart of the gateway's
 * audio.log. Every lifecycle hop, mic route change, socket close, and screen
 * off lands here, so "it stopped responding" after the fact has a timeline
 * instead of a shrug. Two sinks, both local:
 *
 *   files/pppi-voice.log   append-only, rotated at ~1 MB (kept for debugging)
 *   in-memory ring         last [RING_LINES] lines for quick dumps
 *
 * View it any time:
 *   adb shell run-as dev.pppi.omni cat files/pppi-voice.log
 * or from Android Studio's Device File Explorer. Call sites use the level
 * helpers (d/w/e); the tag is part of the message so logcat greps still work.
 */
object VoiceLog {
	private const val RING_LINES = 2000
	private const val ROTATE_BYTES = 1 shl 20

	private val ring = ArrayDeque<String>(RING_LINES)
	private val fileLock = Any()
	private var logFile: File? = null
	private val fmt = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

	fun init(context: Context) {
		synchronized(fileLock) {
			if (logFile != null) return
			logFile = File(context.filesDir, "pppi-voice.log")
			if (logFile.length() > ROTATE_BYTES) {
				logFile.renameTo(File(context.filesDir, "pppi-voice.log.old"))
			}
		}
		i("log started (uptime ${SystemClock.uptimeMillis() / 1000}s, pid ${android.os.Process.myPid()})")
	}

	fun d(tag: String, msg: String) = write("D", tag, msg)
	fun i(tag: String, msg: String) = write("I", tag, msg)
	fun w(tag: String, msg: String) = write("W", tag, msg)
	fun e(tag: String, msg: String, err: Throwable? = null) =
		write("E", tag, if (err != null) "$msg: ${err.javaClass.simpleName}: ${err.message}" else msg)

	/** The last lines as text — for bug reports / a future share button. */
	fun tail(n: Int = RING_LINES): String = synchronized(ring) { ring.takeLast(n).joinToString("\n") }

	private fun write(level: String, tag: String, msg: String) {
		val line = "${fmt.format(Date())} $level/$tag: $msg"
		synchronized(ring) {
			if (ring.size >= RING_LINES) ring.removeFirst()
			ring.addLast(line)
		}
		val f = logFile ?: return
		synchronized(fileLock) {
			try {
				File(f.parentFile, "${f.name}.new").apply {
					appendText("$line\n")
					if (length() > ROTATE_BYTES) f.renameTo(File(f.parentFile, "${f.name}.old")) // next write starts fresh
					else renameTo(f)
				}
			} catch (_: Exception) {
				// disk full / io error — the ring still has it
			}
		}
		android.util.Log.println(when (level) { "W" -> 5; "E" -> 6; "I" -> 4; else -> 3 }, "pppi/$tag", msg)
	}
}
