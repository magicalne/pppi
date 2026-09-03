package dev.sspi.omni

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.input.ImeAction
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/**
 * Tier 1 UI automation: renders the real composables against a scripted fake
 * connection. No network, no server, no microphone — deterministic assertions
 * on what the user sees.
 */
class ChatScreenTest {

	@get:Rule
	val rule = createComposeRule()

	private lateinit var fake: FakeSspiConnection
	private var disconnected = false

	@Before
	fun setUp() {
		fake = FakeSspiConnection()
		disconnected = false
		val theme = themeById("dusk")
		rule.setContent {
			ChatScreen(
				theme = theme,
				server = "http://test:1",
				token = "test-token",
				onDisconnect = { disconnected = true },
				onOpenThemes = {},
				clientFactory = { _, _, onEvent, onConnection ->
					fake.also { it.bind(onEvent, onConnection) }
				},
			)
		}
		rule.waitForIdle()
	}

	@Test
	fun helloOkLoadsHistoryAndConnects() {
		fake.emit(
			ServerEvent.HelloOk(
				agent = AgentInfo(model = "fake/glm", state = "idle"),
				history = listOf(
					ChatEntry(id = "h1", role = "user", text = "earlier question"),
					ChatEntry(id = "h2", role = "assistant", text = "earlier answer"),
				),
			),
		)
		rule.onNodeWithText("earlier question").assertIsDisplayed()
		rule.onNodeWithText("earlier answer").assertIsDisplayed()
	}

	@Test
	fun assistantDeltaStreamsIntoOneBubbleAndFinalReplacesIt() {
		fake.emit(ServerEvent.AssistantDelta(id = "a1", delta = "Hel"))
		fake.emit(ServerEvent.AssistantDelta(id = "a1", delta = "lo"))
		rule.onNodeWithText("Hello").assertIsDisplayed()

		fake.emit(ServerEvent.AssistantFinal(id = "a1", text = "Hello, finished."))
		rule.onNodeWithText("Hello, finished.").assertIsDisplayed()
	}

	@Test
	fun voiceTranscriptShowsMicTag() {
		fake.emit(ServerEvent.Transcript(id = "v1", text = "what is my repo status"))
		rule.onNodeWithText("what is my repo status", substring = true).assertIsDisplayed()
	}

	@Test
	fun composerSendsViaImeAction() {
		rule.onNodeWithTag("sspi.composer").performTextInput("hello omni")
		rule.onNodeWithTag("sspi.composer").performImeAction()
		rule.waitForIdle()
		org.junit.Assert.assertEquals(listOf("hello omni"), fake.chats)
	}

	@Test
	fun helloFailDisconnects() {
		fake.emit(ServerEvent.HelloFail(error = "bad pairing token"))
		rule.waitUntil(timeoutMillis = 5_000) { disconnected }
	}

	@Test
	fun agentStatesRenderWithoutCrashing() {
		fake.onConnection(true)
		fake.emit(ServerEvent.AgentStateEvt(state = "thinking"))
		rule.waitForIdle()
		fake.emit(ServerEvent.AgentStateEvt(state = "tool", toolName = "omni_repos"))
		rule.waitForIdle()
		fake.emit(ServerEvent.AgentStateEvt(state = "idle"))
		rule.onNodeWithContentDescription("connected").assertExists()
	}

	@Test
	fun errorEventsSurfaceAsNotice() {
		fake.emit(ServerEvent.ErrorEvt(message = "boom"))
		rule.onNodeWithText("boom").assertIsDisplayed()
		rule.onNodeWithText("this never existed").assertDoesNotExist()
	}}
