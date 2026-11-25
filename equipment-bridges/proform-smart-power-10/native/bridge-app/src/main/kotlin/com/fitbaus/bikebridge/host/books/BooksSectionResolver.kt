// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

internal data class BooksSection(
    val startMs: Long,
    val endMs: Long,
    val chapter: BooksChapter?,
    val number: Int,
    val count: Int,
) {
    init {
        require(startMs >= 0 && endMs > startMs && endMs - startMs <= BooksSectionResolver.MAX_SECTION_MS)
        require(number in 1..count)
        require(chapter == null || (startMs >= chapter.startMs && endMs <= chapter.endMs))
    }

    fun requiredWindowStarts(): List<Long> {
        val window = RemoteBooksTranscript.WINDOW_MS
        val first = startMs / window * window
        val last = (endMs - 1) / window * window
        return (first..last step window).toList()
    }
}

internal enum class BooksSectionCoverage {
    VERIFIED_REMOTE,
    MISSING_WINDOWS,
    LOCAL_UNVERIFIED,
    UNAVAILABLE,
}

internal data class BooksSectionTranscript(
    val section: BooksSection,
    val coverage: BooksSectionCoverage,
    val overlappingCues: List<BooksCue> = emptyList(),
    val missingWindowStarts: List<Long> = emptyList(),
    val audioRevision: String? = null,
) {
    val containedCues: List<BooksCue>
        get() = overlappingCues.filter { it.startMs >= section.startMs && it.endMs <= section.endMs }
}

internal object BooksSectionResolver {
    const val MAX_SECTION_MS = 600_000L
    private const val FALLBACK_SECTION_MS = 300_000L

    fun at(session: BooksPlaybackSession, positionMs: Long): BooksSection? =
        blockAt(session, positionMs, false)?.at(positionMs)

    fun blockAt(session: BooksPlaybackSession, positionMs: Long, refine: Boolean): BooksSectionBlock? {
        if (positionMs !in 0 until session.durationMs) return null
        val previousIndex = session.chapters.indexOfLast { it.startMs <= positionMs }
        val previous = session.chapters.getOrNull(previousIndex)
        val chapter = previous?.takeIf { positionMs < it.endMs }
        val spanStart = chapter?.startMs ?: previous?.endMs ?: 0L
        val spanEnd = chapter?.endMs ?: session.chapters.getOrNull(previousIndex + 1)?.startMs ?: session.durationMs
        val length = spanEnd - spanStart
        val limit = if (chapter == null) FALLBACK_SECTION_MS
            else if (refine && length > MAX_SECTION_MS) 480_000L else MAX_SECTION_MS
        val count = (length - 1) / limit + 1
        val width = if (chapter == null) limit else (length - 1) / count + 1
        val index = (positionMs - spanStart) / width
        val first = index / 4 * 4
        val last = minOf(first + 4, count)
        val boundaries = (first..last).map { minOf(spanEnd, spanStart + it * width) }
        return BooksSectionBlock(boundaries, chapter, (first + 1).toInt(), count.toInt())
    }

    fun local(section: BooksSection, transcript: BooksTranscript?): BooksSectionTranscript =
        if (transcript == null) BooksSectionTranscript(section, BooksSectionCoverage.UNAVAILABLE)
        else BooksSectionTranscript(section, BooksSectionCoverage.LOCAL_UNVERIFIED,
            transcript.overlappingCues(section.startMs, section.endMs))

    fun remote(
        section: BooksSection,
        windows: Map<Long, RemoteBooksWindow>,
        revision: String?,
    ): BooksSectionTranscript {
        val required = section.requiredWindowStarts()
        val missing = required.filter { start ->
            val window = windows[start]
            window == null || revision == null || window.revision != revision || window.startMs != start ||
                window.endMs < minOf(section.endMs, start + RemoteBooksTranscript.WINDOW_MS) ||
                window.endMs > start + RemoteBooksTranscript.WINDOW_MS
        }
        if (missing.isNotEmpty()) {
            return BooksSectionTranscript(section, BooksSectionCoverage.MISSING_WINDOWS, missingWindowStarts = missing)
        }
        val cues = required.flatMap { start ->
            val window = windows.getValue(start)
            window.transcript.overlappingCues(section.startMs, section.endMs)
        }
        return BooksSectionTranscript(section, BooksSectionCoverage.VERIFIED_REMOTE, cues, audioRevision = revision)
    }
}
