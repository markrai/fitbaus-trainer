// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
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
            listOf("aaaaaaaaaaa", "ddddddddddd", "eeeeeeeeeee"),
            RelatedVideoSuggestions.selectSeeds(feed).map { it.id },
        )
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
    fun suggestionsHaveStrictPerSeedAndTotalBounds() {
        val groups = (0 until 4).map { source ->
            (0 until 40).map { index ->
                video((source * 100 + index).toString().padStart(11, '0'), "New")
            }
        }
        val results = RelatedVideoSuggestions.merge(emptyList(), groups)
        assertEquals(RelatedVideoSuggestions.MAX_RESULTS, results.size)
        assertEquals(results.size, results.map { it.id }.toSet().size)
    }

    private fun video(id: String, channel: String, live: Boolean = false): VideoSummary =
        VideoSummary(id, id, channel, 60, 0, YouTubeIds.thumbnail(id), live)
}
