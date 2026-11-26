// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

internal enum class BooksPresentationMode { ORDINARY, NARRATION, DIAGRAM }

internal sealed class BooksDiagramState {
    object Loading : BooksDiagramState()
    object Unavailable : BooksDiagramState()
    data class Ready(val graph: BooksDiagramGraph) : BooksDiagramState()
}

internal class BooksDiagramScope {
    class Ticket(val identity: BooksDiagramIdentity)
    var ticket: Ticket? = null
        private set
    var state: BooksDiagramState? = null
        private set
    var open = false
        private set

    fun begin(identity: BooksDiagramIdentity): Ticket? {
        if (ticket?.identity?.matches(identity.selection, identity.summary) == true) return null
        return Ticket(identity).also {
            ticket = it
            state = BooksDiagramState.Loading
            open = false
        }
    }

    fun matches(selection: BooksSummarySelection?, summary: BooksSummaryState.Ready?): Boolean =
        ticket?.identity?.matches(selection, summary) == true

    fun show(): Boolean {
        if (ticket == null || state == null) return false
        open = true
        return true
    }

    fun hide() { open = false }

    fun complete(expected: Ticket, result: BooksDiagramState): Boolean {
        if (ticket !== expected) return false
        state = result
        return true
    }

    fun clear() {
        ticket = null
        state = null
        open = false
    }
}


internal class BooksSummaryDrawGate {
    private var generation = 0L
    private var pending: Long? = null
    private var consumed: Long? = null

    fun changed() {
        generation++
    }

    fun begin(visible: Boolean): Long? {
        if (!visible || pending != null || consumed == generation) return null
        return generation.also { pending = it }
    }

    fun finish(ticket: Long, visible: Boolean, deliver: () -> Boolean) {
        if (pending != ticket) return
        pending = null
        if (ticket == generation && visible && deliver()) consumed = ticket
    }

    fun cancel(ticket: Long) {
        if (pending == ticket) pending = null
    }
}
