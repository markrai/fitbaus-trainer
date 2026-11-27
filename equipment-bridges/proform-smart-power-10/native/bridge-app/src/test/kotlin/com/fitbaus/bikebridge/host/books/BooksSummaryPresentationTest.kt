// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BooksSummaryPresentationTest {
    private val revision = "a".repeat(64)

    @Test
    fun preparationAndEmptyStatesAreNotRetriedAutomatically() {
        val preparing = BooksSummaryPresentation.resolve(BooksSummaryState.Preparing)
        val pending = BooksSummaryPresentation.resolve(BooksSummaryState.Pending(revision, listOf(0L)))
        val empty = BooksSummaryPresentation.resolve(BooksSummaryState.Empty(revision))
        assertTrue(preparing.text.contains("Preparing"))
        assertTrue(pending.text.contains("Audio continues"))
        assertTrue(empty.text.contains("No narration"))
        for (state in listOf(preparing, pending, empty)) assertFalse(state.retry)
    }

    @Test
    fun readyUsesPlainSummaryTextRegardlessOfCacheHit() {
        for (hit in listOf(true, false, null)) {
            val state = BooksSummaryState.Ready(revision, "A summary.", "test-model", "section-v1", "b".repeat(64), hit)
            assertEquals(BooksSummaryPresentation("A summary."), BooksSummaryPresentation.resolve(state))
        }
    }

    @Test
    fun failuresHaveActionableTextAndAuthorizationDoesNotOfferRetry() {
        for (failure in BooksSummaryFailure.values()) {
            val result = BooksSummaryPresentation.resolve(BooksSummaryState.Failed(failure))
            assertTrue(result.text.isNotBlank())
            assertEquals(failure != BooksSummaryFailure.AUTHORIZATION, result.retry)
        }
        assertEquals(BooksSummaryPresentation(""), BooksSummaryPresentation.resolve(BooksSummaryState.Cancelled))
    }

    @Test
    fun intervalUsesBookRelativeTimeAndSectionNumber() {
        assertEquals("0:03:00 – 0:09:00", BooksSummaryPresentation.range(BooksSection(180_000, 540_000, null, 1, 1)))
        val chapter = BooksChapter("Chapter", 3_600_000, 4_800_000, 1)
        assertEquals("Section 2 of 2 · 1:10:00 – 1:20:00",
            BooksSummaryPresentation.range(BooksSection(4_200_000, 4_800_000, chapter, 2, 2)))
    }

}
