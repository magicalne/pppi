// Markdown parser + plain-text projection for the Android client (#35).
//
// A faithful port of the web client's hand-rolled renderer (apps/web/src/
// markdown.tsx, issue #16) down to the AST level: same block classification,
// same inline rules, same link-safety allowlist. Compose renders the AST in
// MarkdownText.kt — XSS-safe by construction (no HTML string ever exists;
// text nodes are always escaped by Text(), and links only ever point at
// http/https/mailto — safeHref rejects everything else, including
// javascript: and data:).
//
// Parsing is a pure function of the text; block classification only looks at
// a line and its successor, so streaming deltas never re-shape earlier
// blocks.

package dev.pppi.omni
// ---------------------------------------------------------------- inline AST

sealed class MdInline {
	data class Text(val s: String) : MdInline()
	data class Code(val s: String) : MdInline()
	data class Strong(val c: List<MdInline>) : MdInline()
	data class Em(val c: List<MdInline>) : MdInline()
	data class Link(val href: String, val c: List<MdInline>) : MdInline()
}

// ---------------------------------------------------------------- block AST

sealed class MdBlock {
	data class Para(val c: List<MdInline>) : MdBlock()
	data class Heading(val level: Int, val c: List<MdInline>) : MdBlock()
	data class Code(val lang: String, val s: String) : MdBlock()
	data object Hr : MdBlock()
	data class Quote(val c: List<MdBlock>) : MdBlock()
	data class ListBlock(val ordered: Boolean, val start: Int, val items: List<List<MdInline>>) : MdBlock()
	data class Table(
		val align: List<String?>,
		val head: List<List<MdInline>>,
		val rows: List<List<List<MdInline>>>,
	) : MdBlock()
}

object Markdown {
	// ------------------------------------------------------------ link safety

	private val SAFE_PROTOCOLS = setOf("http", "https", "mailto")

	/** Only http(s)/mailto URLs become links — javascript:, data:, … never do. */
	fun safeHref(raw: String): String? {
		val s = raw.trim()
		if (s.isEmpty()) return null
		if (s.any { it == ' ' || it == '<' || it == '>' || it == '"' || it == '\'' }) return null
		return try {
			val u = java.net.URI(s)
			val scheme = u.scheme?.lowercase() ?: return null
			if (scheme !in SAFE_PROTOCOLS) null else u.toString()
		} catch (_: Exception) {
			null
		}
	}

	// ------------------------------------------------------------ inline parse

	/** index of the `]` matching the `[` at [start], or -1 */
	private fun findCloseBracket(s: String, start: Int): Int {
		var depth = 0
		var i = start
		while (i < s.length) {
			when (s[i]) {
				'\\' -> i++
				'[' -> depth++
				']' -> {
					depth--
					if (depth == 0) return i
				}
			}
			i++
		}
		return -1
	}

	/** trim sentence punctuation that is almost never part of a bare URL */
	private fun trimUrlTail(url: String): String {
		var u = url
		val tail = charArrayOf('.', ',', ';', ':', '!', '?')
		while (u.length > 8 && u.last() in tail) u = u.dropLast(1)
		while (u.endsWith(")")) {
			val opens = u.count { it == '(' }
			val closes = u.count { it == ')' }
			if (closes > opens) u = u.dropLast(1) else break
		}
		return u
	}

	private val AUTOLINK_RE = Regex("^<(https?://[^>\\s]+)>", RegexOption.IGNORE_CASE)
	private val BARE_URL_RE = Regex("^https?://[^\\s<>\"']+")
	private val PUNCT_ESCAPE = Regex("[!-/:-@\\[-`{-~]")
	private val WORD = Regex("\\w")

	fun parseInline(src: String): List<MdInline> {
		val out = mutableListOf<MdInline>()
		val buf = StringBuilder()
		fun flush() {
			if (buf.isNotEmpty()) {
				out.add(MdInline.Text(buf.toString()))
				buf.clear()
			}
		}
		var i = 0
		while (i < src.length) {
			val rest = src.substring(i)
			val ch = rest[0]

			// backslash escape of ASCII punctuation -> literal char
			if (ch == '\\' && rest.length > 1 && PUNCT_ESCAPE.matches(rest[1].toString())) {
				buf.append(rest[1])
				i += 2
				continue
			}

			// code span: run of n backticks closed by another run of n backticks
			if (ch == '`') {
				val run = rest.takeWhile { it == '`' }
				var idx = rest.indexOf(run, run.length)
				while (idx != -1 && (rest.getOrNull(idx - 1) == '`' || rest.getOrNull(idx + run.length) == '`')) {
					idx = rest.indexOf(run, idx + 1)
				}
				if (idx != -1) {
					var content = rest.substring(run.length, idx)
					if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.any { it != ' ' }) {
						content = content.substring(1, content.length - 1)
					}
					flush()
					out.add(MdInline.Code(content))
					i += idx + run.length
					continue
				}
				buf.append(run) // unclosed -> literal
				i += run.length
				continue
			}

			// link / image-as-link: [label](url) — label may nest brackets/escapes
			if (ch == '[' || (ch == '!' && rest.getOrNull(1) == '[')) {
				val bang = if (ch == '!') 1 else 0
				val close = findCloseBracket(rest, bang)
				if (close != -1) {
					val label = rest.substring(bang + 1, close)
					val after = rest.substring(close + 1)
					if (after.startsWith("(")) {
						var depth = 1
						var end = -1
						var j = 1
						while (j < after.length) {
							val c2 = after[j]
							if (c2 == '\\') {
								j++
							} else if (c2 == '(') {
								depth++
							} else if (c2 == ')') {
								depth--
								if (depth == 0) {
									end = j
									break
								}
							}
							j++
						}
						val m = if (end > 1) {
							Regex("^\\s*([^)\\s]+)\\s*(?:\"[^\"]*\"|'[^']*')?\\s*$").find(after.substring(1, end))
						} else {
							null
						}
						if (m != null) {
							var raw = m.groupValues[1]
							if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.substring(1, raw.length - 1)
							val href = safeHref(raw)
							if (href != null) {
								flush()
								out.add(MdInline.Link(href, parseInline(label)))
							} else {
								// unsafe scheme: keep the label as plain text, drop the URL
								buf.append(label)
							}
							i += close + 1 + end + 1
							continue
						}
					}
				}
				buf.append(if (bang == 1) "![" else "[")
				i += bang + 1
				continue
			}

			// angle autolink <https://…> — anything else angle-bracketed stays literal
			val auto = AUTOLINK_RE.find(rest)
			if (ch == '<' && auto != null) {
				val href = safeHref(auto.groupValues[1])
				if (href != null) {
					flush()
					out.add(MdInline.Link(href, listOf(MdInline.Text(auto.groupValues[1]))))
					i += auto.value.length
					continue
				}
			}

			// bare URL autolink (must start after whitespace, "(" or "[")
			val bare = BARE_URL_RE.find(rest)
			if (bare != null && (i == 0 || src[i - 1] == ' ' || src[i - 1] == '\n' || src[i - 1] == '\t' ||
					src[i - 1] == '(' || src[i - 1] == '[')
			) {
				val url = trimUrlTail(bare.value)
				val href = safeHref(url)
				if (href != null) {
					flush()
					out.add(MdInline.Link(href, listOf(MdInline.Text(url))))
					i += bare.value.length
					continue
				}
			}

			// emphasis: ***both*** -> strong(em), **strong**, *em* (and _ twins)
			if ((ch == '*' || ch == '_') && rest.length >= 3 && rest[0] == rest[1] && rest[1] == rest[2]) {
				val close = rest.indexOf(rest.substring(0, 3), 3)
				if (close > 3) {
					flush()
					out.add(MdInline.Strong(listOf(MdInline.Em(parseInline(rest.substring(3, close))))))
					i += close + 3
					continue
				}
			}
			if ((ch == '*' || ch == '_') && rest.getOrNull(1) == ch) {
				val close = rest.indexOf(rest.substring(0, 2), 2)
				if (close > 2) {
					flush()
					out.add(MdInline.Strong(parseInline(rest.substring(2, close))))
					i += close + 2
					continue
				}
			}
			if (ch == '*' || (ch == '_' && (i == 0 || !WORD.matches(src[i - 1].toString())))) {
				val next = rest.getOrNull(1)?.toString() ?: ""
				if (next.isNotEmpty() && next[0] != ' ' && next[0] != '\n' && next[0] != '\t') {
					val close = rest.indexOf(ch, 1)
					if (close > 1 && (ch == '*' || !WORD.matches((rest.getOrNull(close + 1) ?: ' ').toString()))) {
						flush()
						out.add(MdInline.Em(parseInline(rest.substring(1, close))))
						i += close + 1
						continue
					}
				}
			}

			buf.append(ch)
			i++
		}
		flush()
		return out
	}

	// ------------------------------------------------------------ block parse

	private val FENCE_RE = Regex("^ {0,3}(`{3,}|~{3,})(.*)$")
	private val HEADING_RE = Regex("^(#{1,6})(?:[ \\t]+(.*?))?[ \\t]*$")
	private val HR_RE = Regex("^ {0,3}(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})$")
	private val QUOTE_RE = Regex("^ {0,3}>")
	private val LIST_RE = Regex("^ {0,3}([-*+]|\\d{1,9}[.)])(?:[ \\t]+(.*))?$")
	private val BLANK_RE = Regex("^\\s*$")
	private val FENCE_CLOSE_RE = Regex("^[ \\t]{0,3}([`~]+)[ \\t]*$")

	private fun isDelimiterRow(l: String): Boolean {
		val t = l.trim()
		if (!t.contains("|") || !t.contains("-")) return false
		var s = t
		if (s.startsWith("|")) s = s.substring(1)
		s = s.replace(Regex("[ \\t]+$"), "")
		if (s.endsWith("|")) s = s.substring(0, s.length - 1)
		return s.split("|").all { Regex("^:?-+:?$").matches(it.trim()) }
	}

	private fun isTableRow(l: String): Boolean {
		val t = l.trim()
		return t.isNotEmpty() && t.contains("|") && !isDelimiterRow(t)
	}

	/** split a table row into trimmed cells (`\|` escapes a literal pipe) */
	private fun splitCells(l: String): List<String> {
		var t = l.trim()
		if (t.startsWith("|")) t = t.substring(1)
		t = t.replace(Regex("[ \\t]+$"), "")
		if (t.endsWith("|") && !t.endsWith("\\|")) t = t.substring(0, t.length - 1)
		val cells = mutableListOf<String>()
		val cur = StringBuilder()
		var i = 0
		while (i < t.length) {
			val c = t[i]
			if (c == '\\' && t.getOrNull(i + 1) == '|') {
				cur.append('|')
				i++
			} else if (c == '|') {
				cells.add(cur.toString().trim())
				cur.clear()
			} else {
				cur.append(c)
			}
			i++
		}
		cells.add(cur.toString().trim())
		return cells
	}

	private fun alignmentOf(cell: String): String? {
		val m = Regex("^(:?)(-+)(:?)$").find(cell.trim()) ?: return null
		return when {
			m.groupValues[1].isNotEmpty() && m.groupValues[3].isNotEmpty() -> "center"
			m.groupValues[3].isNotEmpty() -> "right"
			m.groupValues[1].isNotEmpty() -> "left"
			else -> null
		}
	}

	/** can the line at [i] start a new block (interrupting a paragraph/list)? */
	private fun isBlockStart(lines: List<String>, i: Int): Boolean {
		val l = lines[i]
		if (FENCE_RE.containsMatchIn(l) || HEADING_RE.containsMatchIn(l) || HR_RE.containsMatchIn(l) ||
			QUOTE_RE.containsMatchIn(l) || LIST_RE.containsMatchIn(l)
		) {
			return true
		}
		return isTableRow(l) && i + 1 < lines.size && isDelimiterRow(lines[i + 1])
	}

	fun parseBlocks(src: String): List<MdBlock> {
		val lines = src.replace(Regex("\r\n?"), "\n").split("\n")
		val blocks = mutableListOf<MdBlock>()
		var i = 0

		while (i < lines.size) {
			val line = lines[i]

			if (BLANK_RE.matches(line)) {
				i++
				continue
			}

			// fenced code — an open fence at EOF is still a code block (streaming)
			val fence = FENCE_RE.find(line)
			if (fence != null) {
				val marker = fence.groupValues[1]
				val info = fence.groupValues[2].trim()
				val lang = if (info.isNotEmpty()) info.split(Regex("\\s+"))[0] else ""
				i++
				val body = mutableListOf<String>()
				while (i < lines.size) {
					val l = lines[i]
					val closeM = FENCE_CLOSE_RE.find(l)
					if (closeM != null && closeM.groupValues[1][0] == marker[0] && closeM.groupValues[1].length >= marker.length) {
						i++
						break
					}
					body.add(l)
					i++
				}
				blocks.add(MdBlock.Code(lang, body.joinToString("\n")))
				continue
			}

			// ATX heading
			val heading = HEADING_RE.find(line)
			if (heading != null) {
				val text = heading.groupValues[2].replace(Regex("[ \\t]+#+[ \\t]*$"), "").trim()
				blocks.add(MdBlock.Heading(heading.groupValues[1].length, parseInline(text)))
				i++
				continue
			}

			// horizontal rule
			if (HR_RE.matches(line)) {
				blocks.add(MdBlock.Hr)
				i++
				continue
			}

			// blockquote (recursively parsed)
			if (QUOTE_RE.containsMatchIn(line)) {
				val inner = mutableListOf<String>()
				while (i < lines.size && QUOTE_RE.containsMatchIn(lines[i])) {
					inner.add(lines[i].replaceFirst(Regex("^ {0,3}>[ \\t]?"), ""))
					i++
				}
				blocks.add(MdBlock.Quote(parseBlocks(inner.joinToString("\n"))))
				continue
			}

			// GFM table: header row + delimiter row, then body rows
			if (isTableRow(line) && i + 1 < lines.size && isDelimiterRow(lines[i + 1])) {
				val head = splitCells(line)
				val align = splitCells(lines[i + 1]).map { alignmentOf(it) }
				i += 2
				val rows = mutableListOf<List<String>>()
				while (i < lines.size && isTableRow(lines[i])) {
					rows.add(splitCells(lines[i]))
					i++
				}
				blocks.add(
					MdBlock.Table(
						align = head.indices.map { align.getOrNull(it) },
						head = head.map { parseInline(it) },
						rows = rows.map { r -> head.indices.map { parseInline(r.getOrNull(it) ?: "") } },
					),
				)
				continue
			}

			// list — flat in v1; continuation lines (incl. lazy) join the last item
			val list = LIST_RE.find(line)
			if (list != null) {
				val ordered = list.groupValues[1][0].isDigit()
				val start = if (ordered) list.groupValues[1].takeWhile { it.isDigit() }.toInt() else 1
				val items = mutableListOf(list.groupValues[2])
				i++
				while (i < lines.size) {
					val l = lines[i]
					if (BLANK_RE.matches(l)) break
					val item = LIST_RE.find(l)
					if (item != null) {
						items.add(item.groupValues[2])
						i++
						continue
					}
					// a new block ends the list (another list item was handled above)
					if (FENCE_RE.containsMatchIn(l) || HEADING_RE.containsMatchIn(l) || HR_RE.matches(l) ||
						QUOTE_RE.containsMatchIn(l)
					) {
						break
					}
					if (isTableRow(l) && i + 1 < lines.size && isDelimiterRow(lines[i + 1])) break
					val cont = l.replaceFirst(Regex("^ {1,4}"), "")
					items[items.size - 1] = if (items[items.size - 1].isNotEmpty()) {
						"${items[items.size - 1]}\n$cont"
					} else {
						cont
					}
					i++
				}
				blocks.add(MdBlock.ListBlock(ordered, start, items.map { parseInline(it) }))
				continue
			}

			// paragraph — single newlines are line breaks (how agents write)
			val para = mutableListOf<String>()
			while (i < lines.size && !BLANK_RE.matches(lines[i]) && !isBlockStart(lines, i)) {
				para.add(lines[i])
				i++
			}
			blocks.add(MdBlock.Para(parseInline(para.joinToString("\n"))))
		}
		return blocks
	}

	// ------------------------------------------------------------ plain text

	/**
	 * Plain-text projection of a markdown message (#12 semantics): emphasis
	 * markers vanish, link syntax becomes "label (url)" (label alone when it
	 * already is the url), fenced code is kept byte-for-byte, lists keep their
	 * markers. Used by the per-message copy affordance.
	 */
	private fun inlineText(nodes: List<MdInline>): String {
		val out = StringBuilder()
		for (n in nodes) {
			when (n) {
				is MdInline.Text -> out.append(n.s) // keeps \n soft breaks
				is MdInline.Code -> out.append(n.s)
				is MdInline.Strong, is MdInline.Em -> out.append(
					inlineText(if (n is MdInline.Strong) n.c else (n as MdInline.Em).c),
				)
				is MdInline.Link -> {
					val label = inlineText(n.c).replace(Regex("\\s+"), " ").trim()
					val href = n.href.trimEnd('/')
					if (label.isEmpty() || label.lowercase() == href.lowercase() || label == n.href) {
						out.append(n.href)
					} else {
						out.append("$label (${n.href})")
					}
				}
			}
		}
		return out.toString()
	}

	private fun blockText(b: MdBlock): String {
		when (b) {
			is MdBlock.Para -> return inlineText(b.c)
			is MdBlock.Heading -> return inlineText(b.c)
			is MdBlock.Code -> return b.s // raw — code copies must be exact
			is MdBlock.Hr -> return "---"
			is MdBlock.Quote -> return b.c
				.map { blockText(it) }
				.joinToString("\n\n")
				.split("\n")
				.joinToString("\n") { l -> "> $l".trimEnd() }
			is MdBlock.ListBlock -> return b.items.mapIndexed { i, item ->
				val marker = if (b.ordered) "${b.start + i}. " else "- "
				marker + inlineText(item).replace("\n", "\n  ")
			}.joinToString("\n")
			is MdBlock.Table -> {
				fun row(cells: List<List<MdInline>>) =
					cells.joinToString(" | ") { inlineText(it).replace("\n", " ") }
				val lines = mutableListOf(row(b.head), b.head.joinToString(" | ") { "---" })
				for (r in b.rows) lines.add(row(r))
				return lines.joinToString("\n")
			}
		}
	}

	/** Full plain text of a (possibly markdown) message body. */
	fun messageToPlainText(src: String): String =
		parseBlocks(src).map { blockText(it) }.filter { it.isNotEmpty() }.joinToString("\n\n")
}
