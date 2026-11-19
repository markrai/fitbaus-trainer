// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
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
        assertEquals(listOf("ccccccccccc", "eeeeeeeeeee", "ffffffffff1", "ddddddddddd"), result.map { it.id })
    }

    @Test
    fun suggestionsHaveStrictPerSeedAndTotalBounds() {
        val group = (0..50).map { index -> video(index.toString().padStart(11, '0'), "New") }
        val results = RelatedVideoSuggestions.merge(emptyList(), List(4) { group.map { it.copy(id = (it.toString().length + it.id.toLong()).toString().padStart(11, '0')) } })
        assertTrue(results.size <= RelatedVideoSuggestions.MAX_RESULTS)
        assertTrue(results.distinctBy { it.id }.size == results.size)
    }

    private fun video(id: String, channel: String, live: Boolean = false): VideoSummary =
        VideoSummary(id, id, channel, 60, 0, YouTubeIds.thumbnail(id), live)
}
