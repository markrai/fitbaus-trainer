package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BooksFloatingPlayerTest {
    private val item = BooksItem("book", "Title", "Author", 600.0, 1)
    private val session = BooksPlaybackSession("session",
        listOf(BooksAudioTrack("http://192.168.1.193:13378/api/items/book/file/123", 0, 600_000)),
        emptyList(), 0)

    @Test
    fun onlyEstablishedNonFailedSessionsCanFloat() {
        assertFalse(BooksFloatingPolicy.canFloat(BooksPlayerState()))
        assertFalse(BooksFloatingPolicy.canFloat(BooksPlayerState(item = item)))
        assertFalse(BooksFloatingPolicy.canFloat(BooksPlayerState(item = item, session = session, failed = true)))
        assertTrue(BooksFloatingPolicy.canFloat(BooksPlayerState(item = item, session = session, playing = true)))
        assertTrue(BooksFloatingPolicy.canFloat(BooksPlayerState(item = item, session = session)))
    }

    @Test
    fun draggingCannotPlaceWindowOutsideHost() {
        assertEquals(BooksFloatingBounds(640, 380, 360, 220),
            BooksFloatingBounds(999, 999, 360, 220).constrained(1000, 600, 260, 170))
        assertEquals(BooksFloatingBounds(0, 0, 360, 220),
            BooksFloatingBounds(-90, -50, 360, 220).constrained(1000, 600, 260, 170))
    }

    @Test
    fun resizingEnforcesMinimumAndHostMaximum() {
        assertEquals(BooksFloatingBounds(0, 0, 260, 170),
            BooksFloatingBounds(0, 0, 50, 30).constrained(1000, 600, 260, 170))
        assertEquals(BooksFloatingBounds(0, 0, 1000, 600),
            BooksFloatingBounds(640, 380, 2000, 2000).constrained(1000, 600, 260, 170))
        assertEquals(BooksFloatingBounds(0, 0, 180, 120),
            BooksFloatingBounds(500, 500, 360, 220).constrained(180, 120, 260, 170))
    }
}
