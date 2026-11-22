// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import java.util.Locale

internal data class RelatedVideoCursor(
    val seeds: List<VideoSummary>,
    val offset: Int,
    val seen: Set<String>,
    val originalSeedCount: Int,
) : FeedCursor

internal object RelatedVideoSuggestions {
    const val MAX_SEEDS = 32
    const val SEEDS_PER_PAGE = 3
    const val MAX_ITEMS_PER_SEED = 12
    const val MAX_RESULTS_PER_PAGE = 24
    const val MAX_TOTAL_SEEDS = 56
    private const val FOLLOW_ON_SEEDS_PER_PAGE = 2

    fun selectSeeds(feed: List<VideoSummary>): List<VideoSummary> {
        val usable = feed.filter { YouTubeIds.isValid(it.id) && !it.live }.distinctBy { it.id }
        val selected = ArrayList<VideoSummary>(minOf(MAX_SEEDS, usable.size))
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

    fun firstPage(feed: List<VideoSummary>, fetch: (VideoSummary) -> List<VideoSummary>): FeedPage {
        val seeds = selectSeeds(feed)
        if (seeds.isEmpty()) return FeedPage(emptyList(), null)
        return nextPage(RelatedVideoCursor(seeds, 0, feed.mapTo(HashSet()) { it.id }, seeds.size), fetch)
    }

    fun nextPage(cursor: RelatedVideoCursor, fetch: (VideoSummary) -> List<VideoSummary>): FeedPage {
        val selected = cursor.seeds.drop(cursor.offset).take(SEEDS_PER_PAGE)
        if (selected.isEmpty()) return FeedPage(emptyList(), null)
        val groups = ArrayList<List<VideoSummary>>(selected.size)
        var firstFailure: Throwable? = null
        for (seed in selected) {
            if (Thread.currentThread().isInterrupted) throw InterruptedException("Discovery cancelled")
            try {
                groups += fetch(seed).take(MAX_ITEMS_PER_SEED)
            } catch (e: Throwable) {
                if (e is InterruptedException || Thread.currentThread().isInterrupted) throw e
                if (firstFailure == null) firstFailure = e
                groups += emptyList()
            }
        }
        if (groups.all { it.isEmpty() }) firstFailure?.let { throw it }
        val items = merge(cursor.seen, groups)
        val seen = HashSet(cursor.seen)
        items.forEach { seen.add(it.id) }
        val queued = HashSet(cursor.seeds.map { it.id })
        val additions = if (cursor.offset < cursor.originalSeedCount && cursor.seeds.size < MAX_TOTAL_SEEDS) {
            selectSeeds(items)
                .filter { queued.add(it.id) }
                .take(minOf(FOLLOW_ON_SEEDS_PER_PAGE, MAX_TOTAL_SEEDS - cursor.seeds.size))
        } else emptyList()
        val seeds = cursor.seeds + additions
        val offset = cursor.offset + selected.size
        val next = if (offset < seeds.size) RelatedVideoCursor(seeds, offset, seen, cursor.originalSeedCount) else null
        return FeedPage(items, next)
    }

    fun merge(feed: List<VideoSummary>, groups: List<List<VideoSummary>>): List<VideoSummary> =
        merge(feed.mapTo(HashSet()) { it.id }, groups)

    fun merge(excludedIds: Set<String>, groups: List<List<VideoSummary>>): List<VideoSummary> {
        val seen = HashSet(excludedIds)
        val result = ArrayList<VideoSummary>(MAX_RESULTS_PER_PAGE)
        val bounded = groups.map { it.take(MAX_ITEMS_PER_SEED) }
        val longest = bounded.maxOfOrNull { it.size } ?: 0
        for (position in 0 until longest) {
            for (group in bounded) {
                val video = group.getOrNull(position) ?: continue
                if (!YouTubeIds.isValid(video.id) || !seen.add(video.id)) continue
                result += video
                if (result.size == MAX_RESULTS_PER_PAGE) return result
            }
        }
        return result
    }
}
