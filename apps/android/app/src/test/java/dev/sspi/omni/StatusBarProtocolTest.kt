package dev.sspi.omni

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StatusBarProtocolTest {

	@Test fun `parses status and model_list events`() {
		val statusJson = """
			{"type":"status","status":{
				"model":{"provider":"openai","id":"gpt-5.1","name":"GPT-5.1","reasoning":true,
					"contextWindow":400000,"thinkingLevelMap":{"off":"none","minimal":null,"low":"low"}},
				"thinkingLevel":"high",
				"thinkingLevels":["off","low","medium","high"],
				"context":{"tokens":22506,"contextWindow":1000000,"percent":2.25}
			}}
		""".trimIndent()
		val evt = protocolJson.decodeFromString(ServerEvent.serializer(), statusJson) as ServerEvent.StatusEvt
		val s = evt.status
		assertEquals("openai", s.model?.provider)
		assertEquals("GPT-5.1", s.model?.name)
		assertTrue(s.model?.reasoning == true)
		assertEquals(400000L, s.model?.contextWindow)
		assertEquals("none", s.model?.thinkingLevelMap?.get("off"))
		assertEquals(null, s.model?.thinkingLevelMap?.get("minimal"))
		assertEquals("high", s.thinkingLevel)
		assertEquals(listOf("off", "low", "medium", "high"), s.thinkingLevels)
		assertEquals(22506L, s.context?.tokens)
		assertEquals(2.25, s.context?.percent!!, 0.001)

		val list = protocolJson.decodeFromString(
			ServerEvent.serializer(),
			"""{"type":"model_list","models":[{"provider":"anthropic","id":"claude-opus-4-8","name":"Claude Opus 4.8","contextWindow":1000000}]}""",
		) as ServerEvent.ModelListEvt
		assertEquals(1, list.models.size)
		assertEquals("Claude Opus 4.8", list.models[0].name)
		assertEquals(false, list.models[0].reasoning)
	}

	@Test fun `status defaults survive a minimal frame`() {
		val evt = protocolJson.decodeFromString(
			ServerEvent.serializer(),
			"""{"type":"status","status":{}}""",
		) as ServerEvent.StatusEvt
		assertEquals(null, evt.status.model)
		assertEquals("off", evt.status.thinkingLevel)
		assertEquals(emptyList<String>(), evt.status.thinkingLevels)
		assertEquals(null, evt.status.context)
	}

	@Test fun `client messages have the wire shape`() {
		assertEquals(
			"""{"type":"set_model","provider":"openai","modelId":"gpt-5.1"}""",
			protocolJson.encodeToString(ClientMessage.serializer(), ClientMessage.SetModel("openai", "gpt-5.1")),
		)
		assertEquals(
			"""{"type":"set_thinking_level","level":"high"}""",
			protocolJson.encodeToString(ClientMessage.serializer(), ClientMessage.SetThinkingLevel("high")),
		)
		assertEquals(
			"""{"type":"list_models"}""",
			protocolJson.encodeToString(ClientMessage.serializer(), ClientMessage.ListModels()),
		)
	}

	@Test fun `brain alpha ramps from dim to fully lit`() {
		val ladder = THINKING_LADDER
		var prev = -1f
		for (lvl in ladder) {
			val a = brainAlpha(lvl)
			assertTrue("$lvl must not go backwards", a >= prev)
			prev = a
		}
		assertEquals(0f, brainAlpha("off"))
		assertEquals(1f, brainAlpha("max"))
		assertEquals(0f, brainAlpha("unknown"))
	}

	@Test fun `token and context formatting matches the web bar`() {
		assertEquals("—", formatTokens(null))
		assertEquals("512", formatTokens(512))
		assertEquals("22.5k", formatTokens(22506))
		assertEquals("400k", formatTokens(400_000))
		assertEquals("1m", formatTokens(1_000_000))
		assertEquals("1.2m", formatTokens(1_200_000))
		assertEquals("22.5k/1m (2%)", formatContext(22506, 1_000_000, 2.2506))
		assertEquals("—/1m (—%)", formatContext(null, 1_000_000, null))
		assertEquals("—", formatContext(100, 0, 5.0))
	}

	@Test fun `chip text appends the native value only when it differs`() {
		assertEquals("off · none", thinkingChipText("off", mapOf("off" to "none")))
		assertEquals("high", thinkingChipText("high", mapOf("high" to "high")))
		assertEquals("max", thinkingChipText("max", emptyMap()))
	}
}
