// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BooksSectionPlansTest {
    private val duration = 3_600_000L
    private val chapter = BooksChapter("Chapter", 0, duration, 1)
    private fun session(chapters: List<BooksChapter> = listOf(chapter)) =
        BooksPlaybackSession("session", listOf(BooksAudioTrack("http://192.168.1.2/api/items/book/file/123", 0, duration)),
            chapters, 0)

    @Test
    fun legacyModeRemainsStableEvenAfterCapabilityChanges() {
        val playback = session()
        val plans = BooksSectionPlans()
        plans.configure(playback, false)
        assertEquals(BooksSectionResolver.at(playback, 700_000), plans.at(playback, 700_000))
        plans.configure(playback, true)
        assertNull(plans.pendingBlock(playback, 700_000))
        assertEquals(BooksSectionResolver.at(playback, 700_000), plans.at(playback, 700_000))
    }

    @Test
    fun refinedBlocksAreBalancedAndCoverChapterWithoutOverlap() {
        val playback = session()
        val first = requireNotNull(BooksSectionResolver.blockAt(playback, 0, true))
        val second = requireNotNull(BooksSectionResolver.blockAt(playback, first.boundaries.last(), true))
        assertEquals(listOf(0L, 450_000L, 900_000L, 1_350_000L, 1_800_000L), first.boundaries)
        assertEquals(first.boundaries.last(), second.boundaries.first())
        assertEquals(duration, second.boundaries.last())
        assertEquals(5, second.firstNumber)
        assertEquals(8, second.count)
        assertEquals(5, second.at(second.boundaries.first())?.number)
    }

    @Test
    fun frozenRefinementIsReusedAfterSeekAndCannotBeOverwritten() {
        val playback = session()
        val plans = BooksSectionPlans()
        plans.configure(playback, true)
        val block = requireNotNull(plans.pendingBlock(playback, 100_000))
        val cuts = listOf(0L, 430_000L, 920_000L, 1_350_000L, 1_800_000L)
        plans.freeze(playback, block, cuts)
        assertEquals(430_000L, plans.at(playback, 100_000)?.endMs)
        assertEquals(2, plans.at(playback, 430_000)?.number)
        assertNull(plans.pendingBlock(playback, 1_000_000))
        assertTrue(plans.pendingBlock(playback, 2_000_000) != null)
        plans.configure(playback, false)
        plans.freeze(playback, block, block.boundaries)
        assertEquals(430_000L, plans.at(playback, 10)?.endMs)
    }

    @Test
    fun nominalFallbackAndBoundedCapacityRemainStableUntilNewSession() {
        val playback = session()
        val plans = BooksSectionPlans(1)
        plans.configure(playback, true)
        val first = requireNotNull(plans.pendingBlock(playback, 10))
        plans.freeze(playback, first, first.boundaries)
        assertNull(plans.pendingBlock(playback, 10))
        assertNull(plans.pendingBlock(playback, 2_000_000))
        assertEquals(450_000L, plans.at(playback, 10)?.endMs)
        val replacement = session()
        plans.configure(replacement, true)
        assertTrue(plans.pendingBlock(replacement, 10) != null)
        plans.clear()
        assertEquals(600_000L, plans.at(replacement, 10)?.endMs)
    }

    @Test
    fun shortChapterAndGapsKeepHardEdges() {
        val small = BooksChapter("Short", 300_000, 900_000, 2)
        val playback = session(listOf(small))
        val gap = requireNotNull(BooksSectionResolver.blockAt(playback, 0, true))
        val chapterBlock = requireNotNull(BooksSectionResolver.blockAt(playback, 300_000, true))
        val after = requireNotNull(BooksSectionResolver.blockAt(playback, 900_000, true))
        assertEquals(listOf(0L, 300_000L), gap.boundaries)
        assertEquals(listOf(300_000L, 900_000L), chapterBlock.boundaries)
        assertEquals(900_000L, after.boundaries.first())
        assertEquals(300_000L, after.boundaries[1] - after.boundaries[0])
        assertFalse(chapterBlock.movable(1))
    }

    @Test
    fun validationRejectsMovedAnchorsExcessShiftAndCutsWithoutSlack() {
        val block = BooksSectionBlock(listOf(0L, 480_000L, 960_000L), null, 1, 2)
        assertTrue(block.accepts(listOf(0L, 450_000L, 960_000L)))
        assertFalse(block.accepts(listOf(1L, 450_000L, 960_000L)))
        assertFalse(block.accepts(listOf(0L, 449_999L, 960_000L)))
        assertFalse(block.accepts(listOf(0L, 480_000L, 960_001L)))
        val noSlack = BooksSectionBlock(listOf(0L, 600_000L, 900_000L), null, 1, 2)
        assertFalse(noSlack.accepts(listOf(0L, 590_000L, 900_000L)))
        assertTrue(noSlack.accepts(noSlack.boundaries))
    }
}
