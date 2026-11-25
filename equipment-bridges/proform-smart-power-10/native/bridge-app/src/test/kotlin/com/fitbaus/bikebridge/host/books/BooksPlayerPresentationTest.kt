package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BooksPlayerPresentationTest {
    @Test
    fun routinePlaybackStatesDoNotConsumeLayoutSpace() {
        for (status in listOf("Playing", "Paused", "Finished", "")) {
            assertEquals("", BooksPlayerPresentation.status(status))
        }
    }

    @Test
    fun bufferingErrorsAndSyncWarningsRemainVisible() {
        for (status in listOf("Buffering…", "Opening audiobook…", "Audio playback failed. Try again.")) {
            assertEquals(status, BooksPlayerPresentation.status(status))
        }
        for (status in listOf("Playing", "Paused", "Finished")) {
            assertEquals("Progress sync unavailable",
                BooksPlayerPresentation.status("$status · Progress sync unavailable"))
        }
    }

    @Test
    fun allSummaryActionsAndPanelAreHiddenOutsideFullscreen() {
        for (discoverable in listOf(false, true)) {
            for (showing in listOf(false, true)) {
                for (recent in listOf(false, true)) {
                    for (book in listOf(false, true)) {
                        assertEquals(BooksSummaryChrome(false, false, false, false),
                            BooksPlayerPresentation.summaryChrome(false, discoverable, showing, recent, book))
                    }
                }
            }
        }
    }

    @Test
    fun fullscreenPreservesDiscoveryCapabilitiesAndReturnToNarration() {
        assertEquals(BooksSummaryChrome(false, true, false, false),
            BooksPlayerPresentation.summaryChrome(true, true, false, false, false))
        assertEquals(BooksSummaryChrome(false, true, true, true),
            BooksPlayerPresentation.summaryChrome(true, true, false, true, true))
        assertEquals(BooksSummaryChrome(true, true, false, false),
            BooksPlayerPresentation.summaryChrome(true, true, true, true, true))
        assertEquals(BooksSummaryChrome(false, false, false, false),
            BooksPlayerPresentation.summaryChrome(true, false, false, false, false))
    }

    @Test
    fun summaryHelpExplainsUnavailablePrerequisites() {
        assertTrue(BooksPlayerPresentation.summaryUnavailable(false, false, false, false).contains("Pair"))
        assertTrue(BooksPlayerPresentation.summaryUnavailable(true, true, false, false).contains("local"))
        assertTrue(BooksPlayerPresentation.summaryUnavailable(true, false, false, false).contains("verified remote narration"))
        assertTrue(BooksPlayerPresentation.summaryUnavailable(true, false, true, false).contains("LLM provider"))
        assertTrue(BooksPlayerPresentation.summaryUnavailable(true, false, true, true).contains("current playback position"))
    }
}
