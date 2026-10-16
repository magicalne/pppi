// Full-screen artifact viewer — the Android twin of the web's sandboxed
// iframe (#17/#28). Sandbox posture (mirrors apps/web/src/Artifact.tsx and
// docs/artifacts.md):
//
//   - scripts run, but the document is loaded with NO base URL and a CSP meta
//     injected first: default-src 'none' → zero network (no fetch/XHR/ws, no
//     external images/fonts/scripts); only inline style/script + data: assets
//   - WebView is locked down: no file or content access, no DOM storage, no
//     database, no text zoom — the artifact is fully self-contained
//   - no popups / top-level navigation out of the viewer by default settings

package dev.pppi.omni

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
fun ArtifactViewer(artifact: Artifact, theme: PppiTheme, onClose: () -> Unit) {
	Dialog(
		onDismissRequest = onClose,
		properties = DialogProperties(usePlatformDefaultWidth = false),
	) {
		Column(Modifier.fillMaxSize().background(theme.bg).statusBarsPadding()) {
			// header: title + close
			Row(
				Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Text(
					artifact.title,
					color = theme.text,
					fontSize = 16.sp,
					fontWeight = FontWeight.SemiBold,
					modifier = Modifier.weight(1f),
				)
				Spacer(Modifier.width(12.dp))
				Text(
					"✕",
					color = theme.dim,
					fontSize = 20.sp,
					modifier = Modifier
						.clickable(onClick = onClose)
						.padding(horizontal = 8.dp, vertical = 4.dp),
				)
			}
			Box(Modifier.fillMaxWidth().height(1.dp).background(theme.line))
			AndroidView(
				factory = { ctx ->
					@SuppressLint("SetJavaScriptEnabled")
					WebView(ctx).apply {
						settings.javaScriptEnabled = true // sandboxed scripts are the point
						settings.allowFileAccess = false
						settings.allowContentAccess = false
						settings.domStorageEnabled = false
						settings.databaseEnabled = false
						settings.saveFormData = false
						settings.textZoom = 100
						isVerticalScrollBarEnabled = true
						isHorizontalScrollBarEnabled = true
						webViewClient = WebViewClient() // keep navigation inside the sandboxed document
						loadDataWithBaseURL(null, artifactDocument(artifact), "text/html", "utf-8", null)
					}
				},
				modifier = Modifier.fillMaxSize().background(Color.White),
			)
		}
	}
}
