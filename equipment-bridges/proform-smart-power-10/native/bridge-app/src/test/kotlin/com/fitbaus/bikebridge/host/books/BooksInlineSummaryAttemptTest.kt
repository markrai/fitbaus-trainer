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
    fun inlineTextCannotJoinOrResizeTheOriginalNarrationScroll() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/books/BooksReadAlong.kt").readText()
        val viewport = File("src/main/kotlin/com/fitbaus/bikebridge/host/books/BooksNarrationViewport.kt").readText()
        assertTrue(source.contains("scroll.addView(narration, FrameLayout.LayoutParams(MATCH, WRAP))"))
        assertTrue(source.contains("scroll.isFillViewport = true"))
        assertTrue(source.contains("narration.gravity = Gravity.CENTER"))
        assertTrue(source.contains("stage.addView(narrationViewport, FrameLayout.LayoutParams(MATCH, MATCH))"))
        assertFalse(source.contains("narrationStack"))
        assertTrue(viewport.contains("narrationScroll.measure(widthMeasureSpec, heightMeasureSpec)"))
        assertTrue(viewport.contains("narrationScroll.layout(0, 0, width, height)"))
        assertTrue(viewport.contains("narration.totalPaddingTop"))
        assertTrue(viewport.contains("summaryScroll.visibility = if (text == null) GONE else VISIBLE"))
        assertTrue(source.contains("narrationViewport.setSummary(text)"))
        assertTrue(source.contains("Typeface.ITALIC"))
        assertFalse(source.contains("flatAction(\"Summary\")"))
        assertFalse(source.contains("flatAction(\"Recap\")"))
        assertFalse(source.contains("flatAction(\"Book recap\")"))
        assertTrue(source.contains("remote.loadRecap(selection"))
        assertTrue(source.contains("remote.loadBookRecap(selection"))
        assertTrue(source.contains("if (value) maybeStartInlineSummary()"))
    }
}
