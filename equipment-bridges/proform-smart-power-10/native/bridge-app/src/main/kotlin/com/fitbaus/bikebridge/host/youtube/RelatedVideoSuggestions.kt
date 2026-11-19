// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import java.util.Locale

internal object RelatedVideoSuggestions {
    const val MAX_SEEDS = 3
    const val MAX_ITEMS_PER_SEED = 12
    const val MAX_RESULTS = 24

    fun selectSeeds(feed: List<VideoSummary>): List<VideoSummary> {
        val usable = feed.filter { YouTubeIds.isValid(it.id) && !it.live }.distinctBy { it.id }
        val selected = ArrayList<VideoSummary>(MAX_SEEDS)
        val channels = HashSet<String>()
        for (item in usable) {
            val channel = item.channel?.trim()?.lowercase(Locale.ROOT).orEmpty()
            if (channel.isNotEmpty() && channels.add(channel)) {
                selected += item
                if (selected.size == MAX_SEEDS) return selected
            }
        }
        for (item in usable) {
            if (selected.none { it.id == item.id }) selected += item
            if (selected.size == MAX_SEEDS) break
        }
        return selected
    }

    fun merge(feed: List<VideoSummary>, groups: List<List<VideoSummary>>): List<VideoSummary> {
        val seen = feed.mapTo(HashSet()) { it.id }
        val result = ArrayList<VideoSummary>(MAX_RESULTS)
        val bounded = groups.map { it.take(MAX_ITEMS_PER_SEED) }
        val longest = bounded.maxOfOrNull { it.size } ?: 0
        for (position in 0 until longest) {
            for (group in bounded) {
                val video = group.getOrNull(position) ?: continue
                if (!YouTubeIds.isValid(video.id) || !seen.add(video.id)) continue
                result += video
                if (result.size == MAX_RESULTS) return result
            }
        }
        return result
    }
}
