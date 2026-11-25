// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BooksSectionResolverTest {
    private fun session(duration: Long, chapters: List<BooksChapter> = emptyList(), tracks: List<BooksAudioTrack>? = null) =
        BooksPlaybackSession("session", tracks ?: listOf(BooksAudioTrack("audio", 0, duration)), chapters, 0)

    private fun chapter(start: Long, end: Long) = BooksChapter("Chapter", start, end, 1)

    private fun section(session: BooksPlaybackSession, position: Long) =
        requireNotNull(BooksSectionResolver.at(session, position))

    private fun window(start: Long, end: Long = start + 300_000, revision: String = "revision", vararg cues: BooksCue) =
        RemoteBooksWindow(start, end, revision, BooksTranscript(cues.toList(), allowEmpty = true))

    @Test
    fun shortChapterRemainsWholeAcrossAudioFiles() {
        val chapter = chapter(20_000, 440_000)
        val tracks = listOf(BooksAudioTrack("first", 0, 200_000), BooksAudioTrack("second", 200_000, 300_000))
        val session = session(500_000, listOf(chapter), tracks)
        val expected = BooksSection(20_000, 440_000, chapter, 1, 1)
        assertEquals(expected, section(session, 20_000))
        assertEquals(expected, section(session, session.position(1, 10_000)))
        assertEquals(expected, section(session, 439_999))
        assertEquals(BooksSection(440_000, 500_000, null, 1, 1), section(session, 440_000))
    }

    @Test
    fun longChapterIsBalancedWithoutTinyTailAndStableAfterSeeking() {
        val chapter = chapter(100_000, 1_300_001)
        val session = session(1_500_000, listOf(chapter))
        val first = BooksSection(100_000, 500_001, chapter, 1, 3)
        val second = BooksSection(500_001, 900_002, chapter, 2, 3)
        val third = BooksSection(900_002, 1_300_001, chapter, 3, 3)
        assertEquals(first, section(session, 500_000))
        assertEquals(second, section(session, 500_001))
        assertEquals(third, section(session, 1_300_000))
        assertEquals(first, section(session, 100_000))
        val exact = chapter(0, 1_800_000)
        val exactSession = session(1_800_000, listOf(exact))
        assertEquals(BooksSection(1_200_000, 1_800_000, exact, 3, 3), section(exactSession, 1_200_000))
    }

    @Test
    fun unchapteredBookUsesFiveMinuteRangesIndependentOfTrackBoundaries() {
        val tracks = listOf(BooksAudioTrack("first", 0, 10_000), BooksAudioTrack("second", 10_000, 640_000))
        val session = session(650_000, tracks = tracks)
        assertEquals(BooksSection(0, 300_000, null, 1, 3), section(session, 299_999))
        assertEquals(BooksSection(300_000, 600_000, null, 2, 3), section(session, 300_000))
        assertEquals(BooksSection(600_000, 650_000, null, 3, 3), section(session, 649_999))
        assertNull(BooksSectionResolver.at(session, -1))
        assertNull(BooksSectionResolver.at(session, 650_000))
        assertNull(BooksSectionResolver.at(session, 700_000))
    }

    @Test
    fun gapsAreSeparateSpansAndNeverCrossKnownChapters() {
        val first = chapter(50_000, 120_000)
        val second = chapter(500_000, 600_000)
        val session = session(700_000, listOf(first, second))
        assertEquals(BooksSection(0, 50_000, null, 1, 1), section(session, 49_999))
        assertEquals(BooksSection(50_000, 120_000, first, 1, 1), section(session, 50_000))
        assertEquals(BooksSection(120_000, 420_000, null, 1, 2), section(session, 120_000))
        assertEquals(BooksSection(420_000, 500_000, null, 2, 2), section(session, 499_999))
        assertEquals(BooksSection(500_000, 600_000, second, 1, 1), section(session, 500_000))
        assertEquals(BooksSection(600_000, 700_000, null, 1, 1), section(session, 600_000))
    }

    @Test
    fun remoteResolutionRequiresAllIntersectingWindowsAndOrdersCues() {
        val section = BooksSection(100_000, 700_000, null, 1, 1)
        val before = BooksCue(90_000, 110_000, "Boundary before")
        val first = BooksCue(120_000, 140_000, "First")
        val second = BooksCue(300_000, 320_000, "Second")
        val after = BooksCue(690_000, 710_000, "Boundary after")
        val a = window(0, cues = arrayOf(before, first))
        val b = window(300_000, cues = arrayOf(second))
        val c = window(600_000, cues = arrayOf(after))
        assertEquals(listOf(0L, 300_000L, 600_000L), section.requiredWindowStarts())
        val incomplete = BooksSectionResolver.remote(section, mapOf(0L to a, 600_000L to c), "revision")
        assertEquals(BooksSectionCoverage.MISSING_WINDOWS, incomplete.coverage)
        assertEquals(listOf(300_000L), incomplete.missingWindowStarts)
        assertTrue(incomplete.overlappingCues.isEmpty())
        val complete = BooksSectionResolver.remote(section, mapOf(600_000L to c, 0L to a, 300_000L to b), "revision")
        assertEquals(BooksSectionCoverage.VERIFIED_REMOTE, complete.coverage)
        assertEquals("revision", complete.audioRevision)
        assertEquals(listOf(before, first, second, after), complete.overlappingCues)
        assertEquals(listOf(first, second), complete.containedCues)
        assertTrue(complete.missingWindowStarts.isEmpty())
    }

    @Test
    fun revisionMismatchAndShortCoverageFailClosed() {
        val section = BooksSection(300_000, 550_000, null, 1, 1)
        assertEquals(listOf(300_000L), section.requiredWindowStarts())
        for (window in listOf(window(300_000, revision = "old"), window(300_000, 549_999), window(300_001))) {
            val result = BooksSectionResolver.remote(section, mapOf(300_000L to window), "revision")
            assertEquals(BooksSectionCoverage.MISSING_WINDOWS, result.coverage)
            assertEquals(listOf(300_000L), result.missingWindowStarts)
            assertTrue(result.overlappingCues.isEmpty())
        }
        val unknown = BooksSectionResolver.remote(section, mapOf(300_000L to window(300_000)), null)
        assertEquals(BooksSectionCoverage.MISSING_WINDOWS, unknown.coverage)
        val silent = BooksSectionResolver.remote(section, mapOf(300_000L to window(300_000, 550_000)), "revision")
        assertEquals(BooksSectionCoverage.VERIFIED_REMOTE, silent.coverage)
        assertTrue(silent.overlappingCues.isEmpty())
    }

    @Test
    fun localFixturesAreNeverClaimedAsVerifiedCoverage() {
        val section = BooksSection(10_000, 20_000, null, 1, 1)
        val outside = BooksCue(0, 10_000, "Outside")
        val boundary = BooksCue(10_000, 12_000, "Inside")
        val trailing = BooksCue(19_000, 21_000, "Straddles")
        val next = BooksCue(21_000, 22_000, "Next")
        val result = BooksSectionResolver.local(section, BooksTranscript(listOf(outside, boundary, trailing, next)))
        assertEquals(BooksSectionCoverage.LOCAL_UNVERIFIED, result.coverage)
        assertEquals(listOf(boundary, trailing), result.overlappingCues)
        assertEquals(listOf(boundary), result.containedCues)
        assertNull(result.audioRevision)
        assertEquals(BooksSectionCoverage.UNAVAILABLE, BooksSectionResolver.local(section, null).coverage)
    }

    @Test
    fun bufferExposesSectionWithoutChangingPrefetchOrEviction() {
        val buffer = ReadAlongWindowBuffer()
        val section = BooksSection(0, 600_000, null, 1, 1)
        val duration = 1_200_000L
        buffer.begin(ReadAlongWindowRequest(0, false))
        buffer.complete(window(0), 0, duration)
        assertEquals(listOf(300_000L), buffer.sectionTranscript(section).missingWindowStarts)
        assertNull(buffer.pendingStart)
        buffer.begin(ReadAlongWindowRequest(300_000, false))
        buffer.complete(window(300_000), 300_000, duration)
        assertEquals(BooksSectionCoverage.VERIFIED_REMOTE, buffer.sectionTranscript(section).coverage)
        buffer.plan(900_000, duration, true)
        assertEquals(listOf(0L, 300_000L), buffer.sectionTranscript(section).missingWindowStarts)
        buffer.clear()
        assertEquals(BooksSectionCoverage.MISSING_WINDOWS, buffer.sectionTranscript(section).coverage)
    }

    @Test
    fun exactWindowEndDoesNotRequestFollowingWindow() {
        assertEquals(listOf(0L), BooksSection(0, 300_000, null, 1, 1).requiredWindowStarts())
        assertEquals(listOf(300_000L), BooksSection(300_000, 300_001, null, 1, 1).requiredWindowStarts())
        assertEquals(listOf(0L, 300_000L), BooksSection(299_999, 300_001, null, 1, 1).requiredWindowStarts())
    }
}
