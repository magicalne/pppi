// Mirror-program TASK 1 tests (#57): sessionsRows projection (fleet list
// with profile colors + states + fallbacks) and history-merge idempotency
// (#22 semantics: hello replaces, older pages prepend deduped).

package dev.pppi.omni

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun peer(
	id: String,
	name: String? = null,
	state: String = "idle",
	worktree: String? = null,
	cwd: String = "/repo",
): PeerSessionDto = PeerSessionDto(sessionId = id, name = name, state = state, cwd = cwd, branch = "main", worktree = worktree)

private fun msg(id: String, text: String = id) = Msg(id, if (id.startsWith("u")) "user" else "assistant", text, "text")

class SessionsUiTest {
	private val dto = SessionsResponseDto(
		omniSessionId = "omni0",
		projects = listOf(
			ProjectGroupDto(
				name = "pppi",
				path = "~/code/pppi",
				sessions = listOf(
					peer("main1", "ppi-dev-1", "busy"),
					peer("wt2", null, "idle", worktree = "android-sessions"),
					peer("road", "road", "unreachable"),
				),
			),
		),
		others = listOf(peer("solo", null)),
		profiles = mapOf(
			"omni0" to ProfileDto("omni0", "omni", "#e8b14a"),
			"main1" to ProfileDto("main1", "ppi-dev-1", "#5b8c51"),
		),
	)

	@Test
	fun projectsTheFleetInDrawerOrder() {
		val rows = sessionsRows(dto, dto.profiles)
		assertEquals(
			listOf(
				"Omni" to SessionRow.Kind.OMNI,
				"ppi-dev-1" to SessionRow.Kind.MAIN,
				"road" to SessionRow.Kind.MAIN,
				"android-sessions" to SessionRow.Kind.WORKTREE,
				"#solo" to SessionRow.Kind.OTHER,
			),
			rows.filter { it.kind != SessionRow.Kind.EMPTY_PROJECT }.map { it.label to it.kind },
		)
		// worktrees indent deeper (drawer depth)
		assertEquals(2, rows.first { it.kind == SessionRow.Kind.WORKTREE }.depth)
	}

	@Test
	fun colorsComeFromTheProfilesMapWithNullFallback() {
		val rows = sessionsRows(dto, dto.profiles)
		assertEquals("#e8b14a", rows.first { it.kind == SessionRow.Kind.OMNI }.colorHex)
		assertEquals("#5b8c51", rows.first { it.key == "main1" }.colorHex)
		// no profile → null → accent at render time (web-drawer parity)
		assertNull(rows.first { it.key == "wt2" }.colorHex)
	}

	@Test
	fun statesFlowThroughAndBusyPlusQueuedIsBusy() {
		val rows = sessionsRows(dto, dto.profiles)
		assertEquals("busy", rows.first { it.key == "main1" }.state)
		assertEquals("unreachable", rows.first { it.key == "road" }.state)
		assertEquals("working…", stateLabelOf("busy+queued"))
		assertEquals("unreachable", stateLabelOf("unreachable"))
		assertEquals("idle", stateLabelOf("idle"))
	}

	@Test
	fun emptyProjectsRenderAsPlaceholders() {
		val dto2 = SessionsResponseDto(
			omniSessionId = "o",
			projects = listOf(ProjectGroupDto("ghost", "~/g")),
			profiles = emptyMap(),
		)
		val rows = sessionsRows(dto2, emptyMap())
		val ghost = rows.first { it.kind == SessionRow.Kind.EMPTY_PROJECT }
		assertEquals("ghost", ghost.label)
	}

	@Test
	fun nullDtoStillShowsTheOmniRow() {
		val rows = sessionsRows(null, emptyMap())
		assertEquals(1, rows.size)
		assertEquals(SessionRow.Kind.OMNI, rows[0].kind)
	}
}

class HistoryMergeTest {
	@Test
	fun helloReplacesIdempotently() {
		val a = listOf(msg("1"), msg("2"))
		val b = listOf(msg("1"), msg("2"))
		assertEquals(b, mergeHelloHistory(a, b))
		// same page twice = same result (#22 reconnect)
		assertEquals(mergeHelloHistory(a, b), mergeHelloHistory(mergeHelloHistory(a, b), b))
	}

	@Test
	fun olderPagesPrependInOrder() {
		val current = listOf(msg("c"), msg("d"))
		val merged = mergeOlderPage(current, listOf(msg("a"), msg("b")))
		assertEquals(listOf("a", "b", "c", "d"), merged.map { it.id })
	}

	@Test
	fun overlapPagesDoNotDuplicate() {
		val current = listOf(msg("b"), msg("c"))
		val merged = mergeOlderPage(current, listOf(msg("a"), msg("b")))
		assertEquals(listOf("a", "b", "c"), merged.map { it.id })
	}

	@Test
	fun emptyOlderIsANoOp() {
		val current = listOf(msg("x"))
		assertEquals(current, mergeOlderPage(current, emptyList()))
		assertTrue(current === mergeOlderPage(current, emptyList()))
	}
}
