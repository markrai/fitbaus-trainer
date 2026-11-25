// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import java.util.Locale

internal data class BooksSummaryPresentation(val text: String, val retry: Boolean = false) {
    companion object {
        fun resolve(state: BooksSummaryState): BooksSummaryPresentation = when (state) {
            BooksSummaryState.Preparing -> BooksSummaryPresentation("Preparing section summary…")
            is BooksSummaryState.Pending -> BooksSummaryPresentation(
                "Preparing narration for this section…\n\nAudio continues while the summary is prepared.")
            is BooksSummaryState.Ready -> BooksSummaryPresentation(state.summary)
            is BooksSummaryState.Empty -> BooksSummaryPresentation("No narration is available to summarize in this section.")
            is BooksSummaryState.Failed -> BooksSummaryPresentation(
                when (state.failure) {
                    BooksSummaryFailure.UNAVAILABLE -> "Summaries are unavailable. Check the Transcriber and its configured summary provider."
                    BooksSummaryFailure.AUTHORIZATION -> "Access was denied. Reconnect to Audiobookshelf or pair the Transcriber again."
                    BooksSummaryFailure.BOOK_CHANGED_OR_TRANSCRIPT_FAILED -> "The audiobook may have changed or its transcription failed. Retry or reopen the audiobook."
                    BooksSummaryFailure.BUSY -> "The summary service is busy. Try again."
                    BooksSummaryFailure.TIMEOUT -> "The summary request timed out. Try again."
                    BooksSummaryFailure.NETWORK_OR_RESPONSE -> "The summary could not be loaded. Check the connection and try again."
                }, retryable(state.failure))
            BooksSummaryState.Cancelled -> BooksSummaryPresentation("")
        }

        fun retryable(failure: BooksSummaryFailure): Boolean = failure != BooksSummaryFailure.AUTHORIZATION

        fun range(section: BooksSection): String {
            val interval = "${stamp(section.startMs)} – ${stamp(section.endMs)}"
            return if (section.count > 1) "Section ${section.number} of ${section.count} · $interval" else interval
        }

        private fun stamp(ms: Long): String {
            val seconds = ms / 1000
            return String.format(Locale.US, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
        }
    }
}
