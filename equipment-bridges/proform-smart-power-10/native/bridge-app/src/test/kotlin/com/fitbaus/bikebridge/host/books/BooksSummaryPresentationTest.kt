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

    @Test
    fun inlineSummaryShowsOnlyNonblankReadyTextInEligibleNarration() {
        val ready = BooksSummaryState.Ready(revision, "  A summary.  ", "test-model", "section-v1", "b".repeat(64), true)
        assertEquals("A summary.", BooksSummaryPresentation.inlineText(ready, true))
        assertEquals(null, BooksSummaryPresentation.inlineText(ready, false))
        assertEquals(null, BooksSummaryPresentation.inlineText(ready.copy(summary = " "), true))
        for (state in listOf(null, BooksSummaryState.Preparing, BooksSummaryState.Pending(revision, listOf(0L)),
                BooksSummaryState.Empty(revision), BooksSummaryState.Failed(BooksSummaryFailure.BUSY),
                BooksSummaryState.Cancelled, BooksSummaryState.Reducing(revision, 1, 2),
                BooksSummaryState.MissingCoverage(revision, 1))) {
            assertEquals(null, BooksSummaryPresentation.inlineText(state, true))
        }
    }

    @Test
    fun inlineFontIsFixedAndSubstantiallySmallerAtEveryNarrationSetting() {
        assertEquals(13f, BooksSummaryPresentation.INLINE_SIZE_SP, 0.01f)
        for (size in 28..52) assertTrue(BooksSummaryPresentation.INLINE_SIZE_SP < size / 2f)
    }

    @Test
    fun summaryAnchorDependsOnlyOnViewportHeight() {
        assertEquals(450, BooksSummaryPresentation.inlineTopPx(600))
        assertEquals(451, BooksSummaryPresentation.inlineTopPx(601))
        assertEquals(300, BooksSummaryPresentation.inlineTopPx(400))
        assertEquals(0, BooksSummaryPresentation.inlineTopPx(0))
    }

    @Test
    fun narrationCollisionHidesSummaryWithoutMovingItsAnchor() {
        for (bottom in listOf(200, 300, 400, 438, 439, 450, 560, 600, 900, 300)) {
            assertEquals(bottom <= 438, BooksSummaryPresentation.inlineFits(600, bottom, 12, 8, 20))
            assertEquals(450, BooksSummaryPresentation.inlineTopPx(600))
        }
        assertFalse(BooksSummaryPresentation.inlineFits(100, 30, 12, 8, 20))
        assertFalse(BooksSummaryPresentation.inlineFits(0, 0, 12, 8, 20))
        assertFalse(BooksSummaryPresentation.inlineFits(600, -1, 12, 8, 20))
        assertFalse(BooksSummaryPresentation.inlineFits(600, 300, 12, 8, 0))
    }

}
