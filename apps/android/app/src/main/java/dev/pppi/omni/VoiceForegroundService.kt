package dev.pppi.omni

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps the interactive voice session alive with the screen off: without a
 * foreground service Android freezes the process, which silently kills both
 * the mic uplink and the websocket. Holds a partial wake lock (CPU) and a
 * high-perf wifi lock (radio) for the duration of the session.
 */
class VoiceForegroundService : Service() {

	private var wakeLock: PowerManager.WakeLock? = null
	private var wifiLock: WifiManager.WifiLock? = null

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onCreate() {
		super.onCreate()
		val nm = getSystemService(NotificationManager::class.java)
		nm.createNotificationChannel(
			NotificationChannel(CHANNEL, "Interactive voice", NotificationManager.IMPORTANCE_LOW),
		)
		val pi = PendingIntent.getActivity(
			this,
			0,
			Intent(this, MainActivity::class.java),
			PendingIntent.FLAG_IMMUTABLE,
		)
		val notification = Notification.Builder(this, CHANNEL)
			.setContentTitle("pppi voice")
			.setContentText("Listening — tap to return")
			.setSmallIcon(android.R.drawable.ic_btn_speak_now)
			.setContentIntent(pi)
			.setOngoing(true)
			.build()
		if (Build.VERSION.SDK_INT >= 30) {
			startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
		} else {
			startForeground(NOTIF_ID, notification)
		}
		wakeLock = getSystemService(PowerManager::class.java)
			.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pppi:voice")
			.apply { acquire(LOCK_TIMEOUT_MS) }
		wifiLock = applicationContext.getSystemService(WifiManager::class.java)
			.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "pppi:voice-wifi")
			.apply { acquire() }
	}

	override fun onDestroy() {
		wakeLock?.takeIf { it.isHeld }?.release()
		wifiLock?.takeIf { it.isHeld }?.release()
		super.onDestroy()
	}

	companion object {
		private const val CHANNEL = "voice"
		private const val NOTIF_ID = 7
		private const val LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000L

		fun start(context: Context) {
			val intent = Intent(context, VoiceForegroundService::class.java)
			if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
		}

		fun stop(context: Context) {
			context.stopService(Intent(context, VoiceForegroundService::class.java))
		}
	}
}
