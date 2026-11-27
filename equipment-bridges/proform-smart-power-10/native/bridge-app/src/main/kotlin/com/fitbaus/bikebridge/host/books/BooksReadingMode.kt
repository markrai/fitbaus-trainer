// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

internal enum class BooksReadingMode(val label: String) {
    NARRATION("narration"),
    SUMMARY("summary"),
    CONCEPTS("concepts"),
}

internal data class BooksReadingAvailability(val summary: Boolean, val concepts: Boolean) {
    fun allows(mode: BooksReadingMode): Boolean = when (mode) {
        BooksReadingMode.NARRATION -> true
        BooksReadingMode.SUMMARY -> summary
        BooksReadingMode.CONCEPTS -> concepts
    }
}

internal class BooksReadingSelection {
    var selected = BooksReadingMode.NARRATION
        private set

    fun reset() {
        selected = BooksReadingMode.NARRATION
    }

    fun select(mode: BooksReadingMode, availability: BooksReadingAvailability): Boolean {
        if (mode == selected || !availability.allows(mode)) return false
        selected = mode
        return true
    }

    fun visibleMode(fullscreen: Boolean): BooksReadingMode =
        if (fullscreen) selected else BooksReadingMode.NARRATION
}
