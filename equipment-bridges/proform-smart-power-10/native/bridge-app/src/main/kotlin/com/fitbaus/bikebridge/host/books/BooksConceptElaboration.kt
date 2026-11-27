package com.fitbaus.bikebridge.host.books

internal sealed class ConceptExplanation {
    object Loading : ConceptExplanation()
    object Unavailable : ConceptExplanation()
    data class Ready(val text: String) : ConceptExplanation()
}

internal class BooksConceptElaboration {
    class Ticket(val index: Int)
    private val pending = mutableMapOf<Int, Ticket>()
    private val ready = mutableMapOf<Int, ConceptExplanation.Ready>()
    var selected: Int? = null
        private set

    fun open(index: Int): Ticket? {
        selected = index
        if (index in ready || index in pending) return null
        return Ticket(index).also { pending[index] = it }
    }

    fun state(index: Int): ConceptExplanation =
        ready[index] ?: if (index in pending) ConceptExplanation.Loading else ConceptExplanation.Unavailable

    fun complete(ticket: Ticket, result: ConceptExplanation): Boolean {
        if (pending[ticket.index] !== ticket) return false
        pending.remove(ticket.index)
        if (result is ConceptExplanation.Ready) ready[ticket.index] = result
        return true
    }

    fun dismiss() {
        selected = null
    }

    fun clear() {
        dismiss()
        pending.clear()
        ready.clear()
    }
}

internal class BooksConceptDoubleTap(private val timeoutMs: Long, private val distance: Float) {
    private data class Tap(val index: Int, val time: Long, val x: Float, val y: Float)
    private var previous: Tap? = null

    fun tap(index: Int, time: Long, x: Float, y: Float): Boolean {
        val last = previous
        val dx = x - (last?.x ?: x)
        val dy = y - (last?.y ?: y)
        val matched = last != null && last.index == index &&
            time - last.time in 0L..timeoutMs && dx * dx + dy * dy <= distance * distance
        previous = if (matched) null else Tap(index, time, x, y)
        return matched
    }

    fun clear() {
        previous = null
    }
}
