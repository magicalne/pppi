package dev.pppi.omni

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
		rule.onNodeWithTag("pppi.connect").performClick()
		rule.onNodeWithText("need a pair link, or a URL + token").assertIsDisplayed()
		assertEquals(null, paired)
	}

	@Test
	fun validInputPairsWithTrimmedServer() {
		setContent()
		rule.onNodeWithTag("pppi.server").performTextInput("http://10.0.2.2:8787/")
		rule.onNodeWithTag("pppi.token").performTextInput("abc123")
		rule.onNodeWithTag("pppi.connect").performClick()
		assertEquals("http://10.0.2.2:8787" to "abc123", paired)
	}

	@Test
	fun pairLinkCarriesTokenWithoutTokenField() {
		setContent()
		rule.onNodeWithTag("pppi.server").performTextInput("http://192.168.1.9:8787/?pair=deadbeef99")
		rule.onNodeWithTag("pppi.connect").performClick()
		assertEquals("http://192.168.1.9:8787" to "deadbeef99", paired)
	}

	@Test
	fun parsePairInputRejectsGarbage() {
		assertEquals(null, parsePairInput("not a url"))
		assertEquals("http://host:1" to "abc", parsePairInput("http://host:1/?pair=abc")) // link is self-sufficient
		assertEquals("http://host:1" to "tok", parsePairInput("http://host:1", "tok"))
		assertEquals(null, parsePairInput("http://host:1")) // url without token anywhere
	}
}
