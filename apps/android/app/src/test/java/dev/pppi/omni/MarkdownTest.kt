// Markdown parser + plain-text projection tests (#35) — the Android twin of
// apps/web/test/markdown.test.ts (#16) + copy.test.ts (#12), pinned at the
// AST level: same input markdown, same structural expectations, so the two
// clients can't drift apart silently.

package dev.pppi.omni

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {
	// ---------------------------------------------------------------- links

	@Test
	fun markdownLinksBecomeSafeLinkNodes() {
		val out = Markdown.parseInline("see [the docs](https://example.com/a?b=1) now")
		assertEquals(
			listOf(
				MdInline.Text("see "),
				MdInline.Link("https://example.com/a?b=1", listOf(MdInline.Text("the docs"))),
				MdInline.Text(" now"),
			),
			out,
		)
	}

	@Test
	fun autolinksBareUrls() {
		val out = Markdown.parseInline("go to https://example.com/page here")
		assertEquals(
			listOf(
				MdInline.Text("go to "),
				MdInline.Link("https://example.com/page", listOf(MdInline.Text("https://example.com/page"))),
				MdInline.Text(" here"),
			),
			out,
		)
	}

	@Test
	fun stripsSentencePunctuationFromBareUrls() {
		val out = Markdown.parseInline("see https://example.com/x.")
		assertEquals("https://example.com/x", (out[1] as MdInline.Link).href)
	}

	@Test
	fun keepsBalancedParensInsideBareUrls() {
		val out = Markdown.parseInline("wiki (https://en.wikipedia.org/wiki/Foo_(bar)) end")
		val link = out.first { it is MdInline.Link } as MdInline.Link
		assertEquals("https://en.wikipedia.org/wiki/Foo_(bar)", link.href)
	}

	@Test
	fun angleAutolinks() {
		val out = Markdown.parseInline("<https://example.com>")
		assertEquals("https://example.com", (out[0] as MdInline.Link).href)
	}

	@Test
	fun codeSpansInsideLinkLabels() {
		val out = Markdown.parseInline("[`code`](https://example.com)")
		val link = out[0] as MdInline.Link
		assertEquals(listOf(MdInline.Code("code")), link.c)
	}

	@Test
	fun imagesRenderAsLinks() {
		val out = Markdown.parseInline("![alt text](https://example.com/i.png)")
		val link = out[1] as MdInline.Link
		assertEquals("https://example.com/i.png", link.href)
		assertEquals(listOf(MdInline.Text("alt text")), link.c)
	}

	@Test
	fun neverAnchorsJavascriptOrDataHrefs() {
		// explicit [x](javascript:…) — unsafe scheme keeps the label, drops the URL
		val out = Markdown.parseInline("click [me](javascript:alert(1)) now")
		assertEquals(
			listOf(MdInline.Text("click "), MdInline.Text("me"), MdInline.Text(" now")),
			out,
		)
		assertNull(Markdown.safeHref("javascript:alert(1)"))
		assertNull(Markdown.safeHref("data:text/html,<script>"))
		assertNull(Markdown.safeHref("vbscript:x"))
		assertEquals("https://a.b", Markdown.safeHref("https://a.b"))
		assertEquals("mailto:a@b.c", Markdown.safeHref("mailto:a@b.c"))
	}

	// ------------------------------------------------------------ inline styles

	@Test
	fun boldItalicNestedEmphasisInlineCode() {
		val out = Markdown.parseInline("**bold** *it* `x y` ***both*** _under_")
		assertEquals(
			listOf(
				MdInline.Strong(listOf(MdInline.Text("bold"))),
				MdInline.Text(" "),
				MdInline.Em(listOf(MdInline.Text("it"))),
				MdInline.Text(" "),
				MdInline.Code("x y"),
				MdInline.Text(" "),
				MdInline.Strong(listOf(MdInline.Em(listOf(MdInline.Text("both"))))),
				MdInline.Text(" "),
				MdInline.Em(listOf(MdInline.Text("under"))),
			),
			out,
		)
	}

	@Test
	fun unclosedEmphasisStaysLiteral() {
		val out = Markdown.parseInline("a * b ** c")
		assertEquals(listOf(MdInline.Text("a * b ** c")), out)
	}

	@Test
	fun backslashEscapesPunctuation() {
		val out = Markdown.parseInline("\\*not em\\*")
		assertEquals(listOf(MdInline.Text("*not em*")), out)
	}

	@Test
	fun underscoreEmphasisDoesNotFireInsideSnakeCaseWords() {
		val out = Markdown.parseInline("snake_case_name stays")
		assertEquals(listOf(MdInline.Text("snake_case_name stays")), out)
	}

	@Test
	fun codeSpanWinsOverEmphasisInsideBackticks() {
		val out = Markdown.parseInline("`a*b*c`")
		assertEquals(listOf(MdInline.Code("a*b*c")), out)
	}

	// ---------------------------------------------------------------- blocks

	@Test
	fun fencedCodeBlock() {
		val blocks = Markdown.parseBlocks("before\n\n```kotlin\nval x = 1\n```\n\nafter")
		assertEquals(
			listOf(
				MdBlock.Para(listOf(MdInline.Text("before"))),
				MdBlock.Code("kotlin", "val x = 1"),
				MdBlock.Para(listOf(MdInline.Text("after"))),
			),
			blocks,
		)
	}

	@Test
	fun openFenceAtEofIsStillACodeBlock() {
		val blocks = Markdown.parseBlocks("typing\n```sh\necho hi")
		assertEquals(
			listOf(
				MdBlock.Para(listOf(MdInline.Text("typing"))),
				MdBlock.Code("sh", "echo hi"),
			),
			blocks,
		)
	}

	@Test
	fun unorderedAndOrderedListsWithContinuations() {
		val blocks = Markdown.parseBlocks("- one\n- two\n  two more\n1. first\n2. second")
		assertEquals(2, blocks.size)
		val ul = blocks[0] as MdBlock.List
		assertEquals(false, ul.ordered)
		assertEquals(
			listOf(listOf(MdInline.Text("one")), listOf(MdInline.Text("two\ntwo more"))),
			ul.items,
		)
		val ol = blocks[1] as MdBlock.List
		assertEquals(true, ol.ordered)
		assertEquals(1, ol.start)
		assertEquals(listOf(MdInline.Text("second")), ol.items[1])
	}

	@Test
	fun singleNewlineParagraphsKeepLineBreaks() {
		val blocks = Markdown.parseBlocks("line one\nline two")
		val p = blocks[0] as MdBlock.Para
		assertEquals(listOf(MdInline.Text("line one\nline two")), p.c)
	}

	@Test
	fun blockquotesNestBlocks() {
		val blocks = Markdown.parseBlocks("> quoted\n> still quoted")
		val q = blocks[0] as MdBlock.Quote
		assertEquals(listOf(MdBlock.Para(listOf(MdInline.Text("quoted\nstill quoted")))), q.c)
	}

	@Test
	fun tablesWithHeaderAlignment() {
		val src = "name | score | note\n:--- | :---: | ---:\nfoo | 1 | a\nbar | 22 | b"
		val t = Markdown.parseBlocks(src)[0] as MdBlock.Table
		assertEquals(listOf("left", "center", "right"), t.align)
		assertEquals(
			listOf(
				listOf(MdInline.Text("name")),
				listOf(MdInline.Text("score")),
				listOf(MdInline.Text("note")),
			),
			t.head,
		)
		assertEquals(listOf(MdInline.Text("22")), t.rows[1][1])
	}

	@Test
	fun tableCanInterruptParagraph() {
		val src = "leading text\na | b\n--- | ---\n1 | 2"
		val blocks = Markdown.parseBlocks(src)
		assertEquals(2, blocks.size)
		assertTrue(blocks[1] is MdBlock.Table)
	}

	@Test
	fun headingsAndRules() {
		val blocks = Markdown.parseBlocks("## Title here\n\n---")
		assertEquals(MdBlock.Heading(2, listOf(MdInline.Text("Title here"))), blocks[0])
		assertEquals(MdBlock.Hr, blocks[1])
	}

	@Test
	fun rawHtmlNeverBecomesStructure() {
		// no HTML passthrough exists: it is just text in a paragraph
		val blocks = Markdown.parseBlocks("<img src=x onerror=alert(1)>")
		assertEquals(1, blocks.size)
		assertEquals(MdBlock.Para::class, blocks[0]::class)
	}

	// ------------------------------------------------------------ plain text

	@Test
	fun plainTextStripsEmphasisAndLinkSyntax() {
		assertEquals(
			"bold and see the docs (https://example.com) now",
			Markdown.messageToPlainText("**bold** and see [the docs](https://example.com) now"),
		)
	}

	@Test
	fun plainTextBareAndAutolinksStaySingle() {
		assertEquals(
			"go https://example.com/x now",
			Markdown.messageToPlainText("go https://example.com/x now"),
		)
	}

	@Test
	fun plainTextKeepsFencedCodeByteForByte() {
		val code = "fun main() {\n    println(\"hi\")\n}"
		assertEquals(code, Markdown.messageToPlainText("```kotlin\n$code\n```"))
	}

	@Test
	fun plainTextListsKeepMarkersAndNumbering() {
		assertEquals(
			"- one\n- two\n  two more\n1. first\n2. second",
			Markdown.messageToPlainText("- one\n- two\n  two more\n\n1. first\n2. second"),
		)
	}

	@Test
	fun plainTextHeadingsQuotesHr() {
		assertEquals(
			"Title here\n\n---\n\n> quoted line",
			Markdown.messageToPlainText("## Title here\n\n---\n\n> quoted line"),
		)
	}

	@Test
	fun plainTextTablesProjectToPipeRows() {
		assertEquals(
			"a | b\n--- | ---\n1 | 2",
			Markdown.messageToPlainText("a | b\n--- | ---\n1 | 2"),
		)
	}

	@Test
	fun plainTextPassthroughUnchanged() {
		assertEquals("just plain text\nsecond line", Markdown.messageToPlainText("just plain text\nsecond line"))
	}

	@Test
	fun plainTextCombinedMessageKeepsOrderAndSpacing() {
		assertEquals(
			"Head\n\n- item one\n- item two\n\ncode line\n\n> a quote",
			Markdown.messageToPlainText("# Head\n\n- item one\n- item two\n\n```\ncode line\n```\n\n> a quote"),
		)
	}
}
