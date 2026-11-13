package dev.pppi.omni

// History merge semantics for the mirror program (#57 TASK 1): hello seeds
// REPLACE (reconnect-idempotent by design — the server sends the same recent
// page), older pages PREPEND deduped by id. Pure functions so the #22
// no-dupes-after-reconnect guarantee is unit-testable without a socket.

/** hello_ok history: the server's recent page is the truth for the seed
 *  window — replace wholesale. Re-receiving the same page on reconnect
 *  yields the same list (idempotent). */
fun mergeHelloHistory(current: List<Msg>, history: List<Msg>): List<Msg> = history

/** A history page of strictly-older entries: prepend, dropping entries the
 *  window already holds (overlap pages after reconnects must not duplicate). */
fun mergeOlderPage(current: List<Msg>, older: List<Msg>): List<Msg> {
	if (older.isEmpty()) return current
	val seen = current.asSequence().map { it.id }.toHashSet()
	val fresh = older.filter { it.id !in seen }
	return fresh + current
}
