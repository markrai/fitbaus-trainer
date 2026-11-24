package com.fitbaus.bikebridge.host.books

internal enum class BooksNarrationPresentation {
    COVER, LOADING, NARRATION, UNAVAILABLE;

    companion object {
        fun resolve(hasDocument: Boolean, ready: Boolean, localMode: Boolean, failed: Boolean): BooksNarrationPresentation =
            when {
                !ready -> COVER
                hasDocument -> NARRATION
                localMode || failed -> UNAVAILABLE
                else -> LOADING
            }
    }
}
