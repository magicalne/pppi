package dev.sspi.omni

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class PairingScreenTest {

	@get:Rule
	val rule = createComposeRule()

	private var paired: Pair<String, String>? = null

	private fun setContent() {
		val theme = themeById("dusk")
		rule.setContent {
			PairingScreen(theme = theme) { s, t -> paired = s to t }
		}
	}

	@Test
	fun emptyFieldsShowValidationError() {
		setContent()
		rule.onNodeWithTag("sspi.connect").performClick()
		rule.onNodeWithText("need a server URL and the token").assertIsDisplayed()
		assertEquals(null, paired)
	}

	@Test
	fun validInputPairsWithTrimmedServer() {
		setContent()
		rule.onNodeWithTag("sspi.server").performTextInput("http://10.0.2.2:8787/")
		rule.onNodeWithTag("sspi.token").performTextInput("abc123")
		rule.onNodeWithTag("sspi.connect").performClick()
		assertEquals("http://10.0.2.2:8787" to "abc123", paired)
	}
}
