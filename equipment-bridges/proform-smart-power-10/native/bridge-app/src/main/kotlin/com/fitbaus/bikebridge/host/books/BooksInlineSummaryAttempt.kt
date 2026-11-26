// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

internal class BooksInlineSummaryAttempt {
    private var attempted: BooksSummarySelection? = null

    fun begin(selection: BooksSummarySelection): Boolean {
        val previous = attempted
        if (previous != null && previous.itemId == selection.itemId && previous.session === selection.session &&
            previous.section == selection.section && previous.expectedRevision == selection.expectedRevision) return false
        mark(selection)
        return true
    }

    fun mark(selection: BooksSummarySelection) {
        attempted = selection
    }

    fun reset() {
        attempted = null
    }
}
