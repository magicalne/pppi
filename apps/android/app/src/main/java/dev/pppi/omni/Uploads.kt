package dev.pppi.omni

// Uploads v2 on Android (#59): the composer's attach affordance. Pure pieces
// (picker mimes, chip models, URL building) are unit-tested; Uploader does
// the same raw-body POST the web client does.

data class PendingUpload(
	val uri: android.net.Uri,
	val name: String,
	val mime: String,
	val size: Long,
)

data class ChipModel(val icon: String, val label: String)

/** mime types offered to the system picker — mirrors the gateway allowlist */
val PICKER_MIME_TYPES = arrayOf(
	"image/png",
	"image/jpeg",
	"image/webp",
	"application/pdf",
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/json",
	"application/xml",
	"text/yaml",
)

/** chip icon + label for a pending/sent attachment (pure, testable) */
fun attachmentChipModel(name: String, mime: String, size: Long): ChipModel {
	val icon = when {
		mime.startsWith("image/") -> "🖼"
		mime == "application/pdf" -> "📕"
		mime == "text/csv" || mime == "application/json" || mime == "application/xml" -> "📄"
		else -> "📁"
	}
	val human = when {
		size >= 1_048_576 -> "%.1fMB".format(size / 1_048_576.0)
		size >= 1_024 -> "${size / 1_024}kB"
		else -> "${size}B"
	}
	return ChipModel(icon, "$name · $human")
}

/** the upload URL the gateway serves (token via query — same as web) */
fun attachmentUrl(server: String, url: String, token: String): String =
	"${server.removeSuffix("/")}${url}?token=$token"

/** raw-body POST /api/upload — returns the attachment ref or null (failure) */
fun uploadAttachment(server: String, token: String, sid: String, name: String, bytes: ByteArray): AttachmentRef? {
	return try {
		val client = okhttp3.OkHttpClient.Builder()
			.connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
			.writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
			.build()
		val url =
			"${server.removeSuffix("/")}/api/upload?sid=${android.net.Uri.encode(sid)}&name=${android.net.Uri.encode(name)}"
		val body = okhttp3.RequestBody.create(null, bytes)
		val req = okhttp3.Request.Builder()
			.url(url)
			.header("Authorization", "Bearer $token")
			.post(body)
			.build()
		client.newCall(req).execute().use { resp ->
			if (!resp.isSuccessful) return null
			val txt = resp.body?.string() ?: return null
			val obj = org.json.JSONObject(txt).getJSONObject("attachment")
			AttachmentRef(
				path = obj.getString("path"),
				name = obj.getString("name"),
				mime = obj.optString("mime", "application/octet-stream"),
				size = obj.optLong("size", 0),
				url = obj.getString("url"),
			)
		}
	} catch (_: Exception) {
		null
	}
}

/** read the picked document into bytes, honoring the 20MB cap client-side */
fun readUploadBytes(resolver: android.content.ContentResolver, uri: android.net.Uri, capBytes: Long = 20L * 1024 * 1024): ByteArray? {
	return try {
		resolver.openInputStream(uri)?.use { input ->
			val buf = java.io.ByteArrayOutputStream()
			val chunk = ByteArray(64 * 1024)
			var total = 0L
			while (true) {
				val n = input.read(chunk)
				if (n <= 0) break
				total += n
				if (total > capBytes) return null
				buf.write(chunk, 0, n)
			}
			buf.toByteArray()
		}
	} catch (_: Exception) {
		null
	}
}
