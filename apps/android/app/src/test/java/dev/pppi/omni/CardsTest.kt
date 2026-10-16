// Task/artifact card logic tests (#35) — the pure helpers behind the Compose
// cards: live-registry merge semantics (#15), per-status detail fallbacks,
// and the artifact CSP document (#17) that gives the WebView the web
// client's zero-network sandbox posture.

package dev.pppi.omni

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CardsTest {
	private fun task(status: String, detail: String? = null) = TaskUpdate("t1", "Deploy v1.2", status, detail)

	@Test
	fun liveTaskLiveWinsOverSnapshot() {
		val snapshot = task("queued")
		val live = mapOf("t1" to task("done", "shipped"))
		assertEquals("done", liveTask(snapshot, live).status)
		assertEquals("shipped", liveTask(snapshot, live).detail)
	}

	@Test
	fun liveTaskFallsBackToEntrySnapshotWhenNoLiveUpdate() {
		val snapshot = task("running")
		assertEquals("running", liveTask(snapshot, emptyMap()).status)
		// other tasks' live updates don't leak in
		val live = mapOf("other" to task("failed"))
		assertEquals("running", liveTask(snapshot, live).status)
	}

	@Test
	fun taskDetailPrefersExplicitDetail() {
		assertEquals("v1.2 live", taskDetail(task("done", "v1.2 live")))
	}

	@Test
	fun taskDetailStatusFallbacksMatchTheWebCopy() {
		assertEquals("queued — starting soon", taskDetail(task("queued")))
		assertEquals("running…", taskDetail(task("running")))
		assertEquals("done — result below/in the conversation", taskDetail(task("done")))
		assertEquals("failed — see the reply for why", taskDetail(task("failed")))
	}

	@Test
	fun taskGlyphsMatchTheWeb() {
		assertEquals("○", taskGlyph("queued"))
		assertEquals("◐", taskGlyph("running"))
		assertEquals("●", taskGlyph("done"))
		assertEquals("✕", taskGlyph("failed"))
	}

	@Test
	fun artifactDocumentInjectsTheCspFirst() {
		val doc = artifactDocument(Artifact("a1", "Report", "html", "<h1>hi</h1>"))
		assertTrue(doc.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\""))
		// the CSP is the web's byte-for-byte (default-src 'none' = zero network)
		assertTrue(doc.contains("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:"))
		assertTrue(doc.endsWith("<h1>hi</h1>"))
		assertFalse(doc.contains("<script src=")) // nothing prepended beyond the meta
	}
}
