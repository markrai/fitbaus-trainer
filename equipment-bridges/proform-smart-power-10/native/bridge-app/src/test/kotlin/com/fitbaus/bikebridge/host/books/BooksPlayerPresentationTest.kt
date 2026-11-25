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
    fun summaryHelpExplainsUnavailablePrerequisites() {
        assertTrue(BooksPlayerPresentation.summaryUnavailable(false, false, false, false).contains("Pair"))
        assertTrue(BooksPlayerPresentation.summaryUnavailable(true, true, false, false).contains("local"))
        assertTrue(BooksPlayerPresentation.summaryUnavailable(true, false, false, false).contains("verified remote narration"))
        assertTrue(BooksPlayerPresentation.summaryUnavailable(true, false, true, false).contains("LLM provider"))
        assertTrue(BooksPlayerPresentation.summaryUnavailable(true, false, true, true).contains("current playback position"))
    }
}
