package com.fitbaus.bikebridge.host.books

internal sealed class ConceptExplanation {
    object Loading : ConceptExplanation()
    object Unavailable : ConceptExplanation()
    data class Streaming(val text: String) : ConceptExplanation()
    data class Incomplete(val text: String) : ConceptExplanation()
    data class Ready(val text: String) : ConceptExplanation()
}

internal class BooksConceptElaboration {
    class Ticket(val index: Int)
    private val pending = mutableMapOf<Int, Ticket>()
    private val ready = mutableMapOf<Int, ConceptExplanation.Ready>()
    private val partial = mutableMapOf<Int, ConceptExplanation.Streaming>()
    private val incomplete = mutableMapOf<Int, ConceptExplanation.Incomplete>()
    var selected: Int? = null
        private set

    fun open(index: Int): Ticket? {
        selected = index
        if (index in ready || index in pending) return null
        incomplete.remove(index)
        return Ticket(index).also { pending[index] = it }
    }

    fun state(index: Int): ConceptExplanation =
        ready[index] ?: partial[index] ?: incomplete[index] ?:
            if (index in pending) ConceptExplanation.Loading else ConceptExplanation.Unavailable

    fun progress(ticket: Ticket, text: String): Boolean {
        if (pending[ticket.index] !== ticket) return false
        partial[ticket.index] = ConceptExplanation.Streaming(text)
        return true
    }

    fun complete(ticket: Ticket, result: ConceptExplanation): Boolean {
        if (pending[ticket.index] !== ticket) return false
        pending.remove(ticket.index)
        partial.remove(ticket.index)
        if (result is ConceptExplanation.Ready) ready[ticket.index] = result
        if (result is ConceptExplanation.Incomplete) incomplete[ticket.index] = result
        return true
    }

    fun dismiss() {
        selected = null
    }

    fun clear() {
        dismiss()
        pending.clear()
        ready.clear()
        partial.clear()
        incomplete.clear()
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
