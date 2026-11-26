// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class BooksInlineSummaryAttemptTest {
    private val session = BooksPlaybackSession("session", listOf(
        BooksAudioTrack("http://192.168.1.193:13378/api/items/book/file/123", 0, 900_000)
    ), emptyList(), 0)
    private val section = BooksSection(0, 300_000, null, 1, 3)
    private val selection = BooksSummarySelection("book", session, section, "a".repeat(64))

    @Test
    fun repeatedTicksDoNotResubmitPendingFailedOrReadySection() {
        val attempt = BooksInlineSummaryAttempt()
        assertTrue(attempt.begin(selection))
        repeat(1000) { assertFalse(attempt.begin(selection.copy())) }
        assertTrue(attempt.begin(selection.copy(section = BooksSection(300_000, 600_000, null, 2, 3))))
        assertTrue(attempt.begin(selection))
        val revised = selection.copy(expectedRevision = "b".repeat(64))
        assertTrue(attempt.begin(revised))
        assertFalse(attempt.begin(revised.copy()))
        val replacementSession = BooksPlaybackSession(session.id, session.tracks, session.chapters, session.resumeMs)
        val reopened = revised.copy(session = replacementSession)
        assertTrue(attempt.begin(reopened))
        assertFalse(attempt.begin(reopened.copy()))
        val otherItem = reopened.copy(itemId = "other")
        assertTrue(attempt.begin(otherItem))
        assertFalse(attempt.begin(otherItem.copy()))
        attempt.reset()
        assertTrue(attempt.begin(selection))
    }

    @Test
    fun resolvedSectionPlanReplacesNominalAttemptIdentity() {
        val attempt = BooksInlineSummaryAttempt()
        assertTrue(attempt.begin(selection))
        val resolved = selection.copy(section = BooksSection(0, 310_000, null, 1, 3))
        attempt.mark(resolved)
        assertFalse(attempt.begin(resolved))
    }

    @Test
    fun inlineTextSharesNarrationViewportAndDoesNotReserveSpaceWhenEmpty() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/books/BooksReadAlong.kt").readText()
        assertTrue(source.contains("narrationStack.addView(narration, LayoutParams(MATCH, WRAP))"))
        assertTrue(source.contains("narrationStack.addView(inlineSummary, LayoutParams(MATCH, WRAP)"))
        assertTrue(source.contains("inlineSummary.visibility = if (text == null) GONE else VISIBLE"))
        assertTrue(source.contains("stage.addView(scroll, FrameLayout.LayoutParams(MATCH, MATCH))"))
        assertTrue(source.contains("Typeface.ITALIC"))
        assertFalse(source.contains("flatAction(\"Summary\")"))
        assertFalse(source.contains("flatAction(\"Recap\")"))
        assertFalse(source.contains("flatAction(\"Book recap\")"))
        assertTrue(source.contains("remote.loadRecap(selection"))
        assertTrue(source.contains("remote.loadBookRecap(selection"))
        assertTrue(source.contains("if (value) maybeStartInlineSummary()"))
    }
}
