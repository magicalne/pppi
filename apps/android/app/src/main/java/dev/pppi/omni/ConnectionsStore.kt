package dev.pppi.omni

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** One paired machine (gateway + its omni). The token is the only credential held on-device. */
@Serializable
data class Connection(
	val id: String, // the url — stable identity for a machine endpoint
	val name: String,
	val url: String,
	val token: String,
	val color: String? = null,
)

/** http://ip:port/?pair=token → (url, token); plain http URLs need the token separately. */
fun parsePairInput(raw: String, tokenFallback: String = ""): Pair<String, String>? {
	val s = raw.trim().trimEnd('/')
	if (s.isEmpty()) return null
	val m = Regex("^(https?://[^\\s?]+)/\\?pair=([A-Za-z0-9]+)$").find(s)
	if (m != null) return Pair(m.groupValues[1], m.groupValues[2])
	if (!s.startsWith("http")) return null
	val t = tokenFallback.trim()
	return if (t.isNotEmpty()) Pair(s, t) else null
}

/** Machine-scoped connection list backed by SharedPreferences. */
class ConnectionsStore(context: Context, prefsName: String = "pppi") {

	private val prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
	private val json = Json { ignoreUnknownKeys = true }

	fun load(): List<Connection> {
		val raw = prefs.getString("connections", null) ?: return migrateLegacy()
		return try {
			json.decodeFromString<List<Connection>>(raw)
		} catch (_: Exception) {
			migrateLegacy()
		}
	}

	fun save(list: List<Connection>) {
		prefs.edit().putString("connections", json.encodeToString(list)).apply()
		if (list.isNotEmpty()) prefs.edit().remove("server").remove("token").apply()
	}

	/** v0 pairing kept two loose prefs; fold them into one connection once. */
	private fun migrateLegacy(): List<Connection> {
		val server = prefs.getString("server", null)
		val token = prefs.getString("token", null)
		val list = if (!server.isNullOrBlank() && !token.isNullOrBlank()) {
			listOf(Connection(id = server, name = hostOf(server), url = server, token = token))
		} else emptyList()
		save(list)
		return list
	}

	companion object {
		fun hostOf(url: String): String = try {
			java.net.URI(url).host ?: url
		} catch (_: Exception) {
			url
		}
	}
}
