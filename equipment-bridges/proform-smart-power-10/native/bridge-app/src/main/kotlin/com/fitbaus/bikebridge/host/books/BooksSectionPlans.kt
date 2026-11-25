// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

internal data class BooksSectionBlock(
    val boundaries: List<Long>,
    val chapter: BooksChapter?,
    val firstNumber: Int,
    val count: Int,
) {
    init {
        require(boundaries.size in 2..5 && boundaries.first() >= 0)
        require(boundaries.zipWithNext().all { (a, b) -> b > a && b - a <= BooksSectionResolver.MAX_SECTION_MS })
        require(firstNumber >= 1 && firstNumber + boundaries.size - 2 <= count)
        require(chapter == null || (boundaries.first() >= chapter.startMs && boundaries.last() <= chapter.endMs))
    }

    fun movable(index: Int): Boolean =
        index in 1 until boundaries.lastIndex &&
            boundaries[index] - boundaries[index - 1] in 60_001L..540_000L &&
            boundaries[index + 1] - boundaries[index] in 60_001L..540_000L

    fun accepts(cuts: List<Long>): Boolean =
        cuts.size == boundaries.size && cuts.first() == boundaries.first() && cuts.last() == boundaries.last() &&
            cuts.zipWithNext().all { (a, b) -> b > a && b - a <= BooksSectionResolver.MAX_SECTION_MS } &&
            cuts.indices.all { i -> if (movable(i)) cuts[i] in (boundaries[i] - 30_000L)..(boundaries[i] + 30_000L)
                else cuts[i] == boundaries[i] }

    fun at(positionMs: Long, cuts: List<Long> = boundaries): BooksSection? {
        if (positionMs !in cuts.first() until cuts.last()) return null
        val index = cuts.indexOfLast { it <= positionMs }
        return BooksSection(cuts[index], cuts[index + 1], chapter, firstNumber + index, count)
    }
}

internal class BooksSectionPlans(private val maxBlocks: Int = 256) {
    private var session: BooksPlaybackSession? = null
    private var enabled = false
    private var configured = false
    private val frozen = mutableMapOf<BooksSectionBlock, List<Long>>()

    init { require(maxBlocks > 0) }

    fun configure(playback: BooksPlaybackSession, available: Boolean) {
        if (session !== playback) {
            clear()
            session = playback
        }
        if (!configured) {
            configured = true
            enabled = available
        }
    }

    fun at(playback: BooksPlaybackSession, positionMs: Long): BooksSection? {
        val block = BooksSectionResolver.blockAt(playback, positionMs, session === playback && enabled) ?: return null
        return block.at(positionMs, if (session === playback) frozen[block] ?: block.boundaries else block.boundaries)
    }

    fun pendingBlock(playback: BooksPlaybackSession, positionMs: Long): BooksSectionBlock? {
        if (session !== playback || !enabled || frozen.size >= maxBlocks) return null
        val block = BooksSectionResolver.blockAt(playback, positionMs, true) ?: return null
        return block.takeIf { it !in frozen && it.boundaries.indices.any(it::movable) }
    }

    fun freeze(playback: BooksPlaybackSession, block: BooksSectionBlock, cuts: List<Long>) {
        if (session !== playback || !enabled || block in frozen || frozen.size >= maxBlocks) return
        require(block.accepts(cuts))
        frozen[block] = cuts.toList()
    }

    fun clear() {
        session = null
        configured = false
        enabled = false
        frozen.clear()
    }
}
