// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RelatedVideoSuggestionsTest {
    @Test
    fun seedsPreferDistinctSubscribedChannelsAndIgnoreLiveVideos() {
        val feed = listOf(
            video("aaaaaaaaaaa", "A"),
            video("bbbbbbbbbbb", "A"),
            video("ccccccccccc", "B", live = true),
            video("ddddddddddd", "B"),
            video("eeeeeeeeeee", "C"),
            video("ffffffffff1", "D"),
        )
        assertEquals(
            listOf("aaaaaaaaaaa", "ddddddddddd", "eeeeeeeeeee", "ffffffffff1", "bbbbbbbbbbb"),
            RelatedVideoSuggestions.selectSeeds(feed).map { it.id },
        )
    }

    @Test
    fun seedPoolHasAnUpperBoundAndIgnoresDuplicates() {
        val feed = (1..70).map { video(it.toString().padStart(11, '0'), "Channel $it") }
        assertEquals(RelatedVideoSuggestions.MAX_SEEDS, RelatedVideoSuggestions.selectSeeds(feed + feed).size)
    }

    @Test
    fun suggestionsInterleaveSourcesExcludeFeedAndDeduplicate() {
        val feed = listOf(video("aaaaaaaaaaa", "One"), video("bbbbbbbbbbb", "Two"))
        val first = listOf(video("ccccccccccc", "New"), feed[0], video("ddddddddddd", "New"))
        val second = listOf(video("ccccccccccc", "New"), video("eeeeeeeeeee", "New"), video("ffffffffff1", "New"))
        val result = RelatedVideoSuggestions.merge(feed, listOf(first, second))
        assertEquals(listOf("ccccccccccc", "eeeeeeeeeee", "ddddddddddd", "ffffffffff1"), result.map { it.id })
    }

    @Test
    fun suggestionsHaveStrictPerSeedAndPageBounds() {
        val groups = (0 until 4).map { source ->
            (0 until 40).map { index ->
                video((source * 100 + index).toString().padStart(11, '0'), "New")
            }
        }
        val results = RelatedVideoSuggestions.merge(emptyList(), groups)
        assertEquals(RelatedVideoSuggestions.MAX_RESULTS_PER_PAGE, results.size)
        assertEquals(results.size, results.map { it.id }.toSet().size)
    }

    @Test
    fun subsequentPagesRotateSeedsAndNeverRepeatPreviouslyShownVideos() {
        val feed = (1..7).map { video(it.toString().padStart(11, '0'), "Channel $it") }
        val expanded = ArrayList<String>()
        val fetch: (VideoSummary) -> List<VideoSummary> = { seed ->
            expanded += seed.id
            listOf(video("99999999999", "Shared"), video("1" + seed.id.drop(1), "Related"))
        }
        val first = RelatedVideoSuggestions.firstPage(feed, fetch)
        assertEquals(4, first.items.size)
        val second = RelatedVideoSuggestions.nextPage(first.cursor as RelatedVideoCursor, fetch)
        assertEquals(3, second.items.size)
        assertTrue(first.items.map { it.id }.toSet().intersect(second.items.map { it.id }.toSet()).isEmpty())
        assertEquals(6, expanded.size)
        assertEquals(feed.take(6).map { it.id }, expanded)
    }

    @Test
    fun discoveryCanFillManyPagesButEventuallyExhaustsItsBoundedSeedQueue() {
        val feed = (1..32).map { video(it.toString().padStart(11, '0'), "Channel $it") }
        var nextId = 1000
        var requests = 0
        var page = RelatedVideoSuggestions.firstPage(feed) {
            requests += 1
            (1..12).map { video((++nextId).toString().padStart(11, '0'), "Related") }
        }
        val all = HashSet<String>()
        var pages = 0
        while (true) {
            pages += 1
            for (video in page.items) assertTrue(all.add(video.id))
            val next = page.cursor as? RelatedVideoCursor ?: break
            assertTrue(pages < 30)
            assertTrue(next.seeds.size <= RelatedVideoSuggestions.MAX_TOTAL_SEEDS)
            page = RelatedVideoSuggestions.nextPage(next) {
                requests += 1
                (1..12).map { video((++nextId).toString().padStart(11, '0'), "Related") }
            }
        }
        assertTrue(pages > 10)
        assertTrue(all.size > 24)
        assertTrue(requests <= RelatedVideoSuggestions.MAX_TOTAL_SEEDS)
    }

    @Test
    fun emptyBatchAdvancesTheCursorWithoutAnInfiniteRetryLoop() {
        val feed = (1..5).map { video(it.toString().padStart(11, '0'), "Channel $it") }
        val first = RelatedVideoSuggestions.firstPage(feed) { emptyList() }
        assertTrue(first.items.isEmpty())
        val next = RelatedVideoSuggestions.nextPage(first.cursor as RelatedVideoCursor) { emptyList() }
        assertTrue(next.items.isEmpty())
        assertFalse(next.cursor != null)
    }

    private fun video(id: String, channel: String, live: Boolean = false): VideoSummary =
        VideoSummary(id, id, channel, 60, 0, YouTubeIds.thumbnail(id), live)
}
