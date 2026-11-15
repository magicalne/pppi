// Uploads v2 on Android (#59): chip models + picker mimes + URL building —
// the pure pieces the composer UI renders.

package dev.pppi.omni

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadsTest {
	@Test
	fun pickerMimesMirrorTheGatewayAllowlist() {
		val mimes = PICKER_MIME_TYPES.toList()
		assertTrue(mimes.containsAll(listOf("image/png", "image/jpeg", "image/webp", "application/pdf")))
		assertTrue(mimes.contains("text/plain"))
		assertTrue(mimes.contains("application/json"))
		assertEquals(10, mimes.size)
	}

	@Test
	fun pickedNamesAreFilteredAgainstTheAllowlist() {
		assertTrue(isAllowedUploadName("shot.png"))
		assertTrue(isAllowedUploadName("Spec.PDF"))
		assertTrue(isAllowedUploadName("data.json"))
		assertTrue(!isAllowedUploadName("tool.exe"))
		assertTrue(!isAllowedUploadName("archive.zip"))
		assertTrue(!isAllowedUploadName("noext"))
	}

	@Test
	fun chipModelsPickIconsByType() {
		assertEquals("🖼", attachmentChipModel("shot.png", "image/png", 10).icon)
		assertEquals("📕", attachmentChipModel("spec.pdf", "application/pdf", 10).icon)
		assertEquals("📄", attachmentChipModel("data.csv", "text/csv", 10).icon)
		assertEquals("📁", attachmentChipModel("y.yaml", "text/yaml", 10).icon)
	}

	@Test
	fun chipLabelsHumanizeSizes() {
		assertEquals("a.txt · 42B", attachmentChipModel("a.txt", "text/plain", 42).label)
		assertEquals("a.md · 3kB", attachmentChipModel("a.md", "text/markdown", 3 * 1024).label)
		assertEquals("book.pdf · 1.5MB", attachmentChipModel("book.pdf", "application/pdf", (1.5 * 1024 * 1024).toLong()).label)
	}

	@Test
	fun attachmentUrlJoinsServerPathAndToken() {
		assertEquals(
			"http://192.168.2.85:8787/api/uploads/s/1-a.png?token=tok",
			attachmentUrl("http://192.168.2.85:8787/", "/api/uploads/s/1-a.png", "tok"),
		)
	}
}
