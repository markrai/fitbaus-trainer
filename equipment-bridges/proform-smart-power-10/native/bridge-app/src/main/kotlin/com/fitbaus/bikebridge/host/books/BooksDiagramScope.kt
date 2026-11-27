// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

internal sealed class BooksDiagramState {
    object Loading : BooksDiagramState()
    object Unavailable : BooksDiagramState()
    data class Ready(val graph: BooksDiagramGraph) : BooksDiagramState()
    data class Concepts(val snippets: List<String>) : BooksDiagramState()
}

internal class BooksDiagramScope {
    class Ticket(val identity: BooksDiagramIdentity)
    var ticket: Ticket? = null
        private set
    var state: BooksDiagramState? = null
        private set

    fun begin(identity: BooksDiagramIdentity): Ticket? {
        if (ticket?.identity?.matches(identity.selection, identity.summary) == true) return null
        return Ticket(identity).also {
            ticket = it
            state = BooksDiagramState.Loading
        }
    }

    fun matches(selection: BooksSummarySelection?, summary: BooksSummaryState.Ready?): Boolean =
        ticket?.identity?.matches(selection, summary) == true

    fun complete(expected: Ticket, result: BooksDiagramState): Boolean {
        if (ticket !== expected) return false
        state = result
        return true
    }

    fun clear() {
        ticket = null
        state = null
    }
}
