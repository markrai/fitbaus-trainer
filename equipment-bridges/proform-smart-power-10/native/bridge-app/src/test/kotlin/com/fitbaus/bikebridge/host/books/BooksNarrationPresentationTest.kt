package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class BooksNarrationPresentationTest {
    @Test
    fun coverWhileOpeningOrPlaybackFailed() {
        assertEquals(BooksNarrationPresentation.COVER, BooksNarrationPresentation.resolve(false, false, false, false))
        assertEquals(BooksNarrationPresentation.COVER, BooksNarrationPresentation.resolve(true, false, false, false))
    }

    @Test
    fun coverWhileWaitingAndWhenUnavailable() {
        assertEquals(BooksNarrationPresentation.LOADING, BooksNarrationPresentation.resolve(false, true, false, false))
        assertEquals(BooksNarrationPresentation.UNAVAILABLE, BooksNarrationPresentation.resolve(false, true, true, false))
        assertEquals(BooksNarrationPresentation.UNAVAILABLE, BooksNarrationPresentation.resolve(false, true, false, true))
    }

    @Test
    fun availableDocumentTakesPriorityIncludingSilentWindows() {
        assertEquals(BooksNarrationPresentation.NARRATION, BooksNarrationPresentation.resolve(true, true, false, false))
        assertEquals(BooksNarrationPresentation.NARRATION, BooksNarrationPresentation.resolve(true, true, true, false))
    }
}
