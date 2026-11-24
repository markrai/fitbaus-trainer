package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ReadAlongWindowBufferTest {
    private val duration = 1_250_000L

    private fun window(start: Long) = RemoteBooksWindow(start, minOf(start + 300_000, duration), "revision",
        BooksTranscript(listOf(BooksCue(start, start + 1000, "Window $start"))))

    private fun ready(buffer: ReadAlongWindowBuffer, start: Long, position: Long = start) {
        buffer.begin(ReadAlongWindowRequest(start, false))
        buffer.complete(window(start), position, duration)
    }

    @Test
    fun prefetchKeepsCurrentTextAndSwitchesAtBoundary() {
        val buffer = ReadAlongWindowBuffer()
        assertEquals(ReadAlongWindowRequest(0, false), buffer.plan(10, duration, true))
        ready(buffer, 0)
        val next = requireNotNull(buffer.plan(10, duration, true))
        assertEquals(ReadAlongWindowRequest(300_000, false), next)
        buffer.begin(next)
        assertEquals("Window 0", buffer.current(10, duration)?.transcript?.cueAt(10)?.text)
        assertNull(buffer.plan(100, duration, true))
        buffer.complete(window(300_000), 100, duration)
        assertEquals(0L, buffer.current(299_999, duration)?.startMs)
        assertEquals("Window 300000", buffer.current(300_000, duration)?.transcript?.cueAt(300_000)?.text)
        assertEquals(ReadAlongWindowRequest(600_000, false), buffer.plan(300_000, duration, true))
    }

    @Test
    fun crossingWhilePrefetchPendingDoesNotSubmitAgain() {
        val buffer = ReadAlongWindowBuffer()
        ready(buffer, 0)
        buffer.begin(requireNotNull(buffer.plan(100, duration, true)))
        assertNull(buffer.plan(300_001, duration, true))
        assertNull(buffer.current(300_001, duration))
        buffer.complete(window(300_000), 300_001, duration)
        assertEquals(300_000L, buffer.current(300_001, duration)?.startMs)
    }

    @Test
    fun seekingPrioritizesMissingCurrentWindow() {
        val buffer = ReadAlongWindowBuffer()
        ready(buffer, 0)
        buffer.begin(requireNotNull(buffer.plan(100, duration, true)))
        val seek = buffer.plan(900_500, duration, true)
        assertEquals(ReadAlongWindowRequest(900_000, false), seek)
        buffer.begin(requireNotNull(seek))
        buffer.complete(window(900_000), 900_500, duration)
        assertNull(buffer.current(0, duration))
        assertEquals(ReadAlongWindowRequest(1_200_000, false), buffer.plan(900_500, duration, true))
    }

    @Test
    fun previousWindowIsRetainedAndOlderWindowsAreEvicted() {
        val buffer = ReadAlongWindowBuffer()
        ready(buffer, 0)
        ready(buffer, 300_000, 0)
        ready(buffer, 600_000, 300_000)
        assertEquals(0L, buffer.current(100, duration)?.startMs)
        buffer.plan(600_001, duration, true)
        assertNull(buffer.current(100, duration))
        assertEquals(300_000L, buffer.current(300_001, duration)?.startMs)
    }

    @Test
    fun failedPrefetchRetriesOnDemandButForegroundFailureWaitsForReload() {
        val buffer = ReadAlongWindowBuffer()
        ready(buffer, 0)
        buffer.begin(requireNotNull(buffer.plan(100, duration, true)))
        buffer.fail(100, duration)
        assertFalse(buffer.failed(100, duration))
        assertNull(buffer.plan(100, duration, true))
        val next = buffer.plan(300_001, duration, true)
        assertEquals(ReadAlongWindowRequest(300_000, true), next)
        buffer.begin(requireNotNull(next))
        buffer.fail(300_001, duration)
        assertTrue(buffer.failed(300_001, duration))
        assertNull(buffer.plan(300_001, duration, true))
        assertEquals(ReadAlongWindowRequest(300_000, true), buffer.reload(300_001, duration))
    }

    @Test
    fun pausedAndFinalWindowsDoNotPrefetchAndClearResetsIdentity() {
        val buffer = ReadAlongWindowBuffer()
        ready(buffer, 0)
        assertNull(buffer.plan(10, duration, false))
        ready(buffer, 1_200_000)
        assertNull(buffer.plan(1_249_000, duration, true))
        buffer.clear()
        assertNull(buffer.revision)
        assertNull(buffer.pendingStart)
        assertNull(buffer.current(1_249_000, duration))
    }
}
