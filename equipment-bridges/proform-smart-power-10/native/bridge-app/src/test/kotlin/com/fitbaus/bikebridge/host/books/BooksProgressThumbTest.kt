// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class BooksProgressThumbTest {
    @Test
    fun percentIsClampedAndNeverFinishesEarly() {
        assertEquals(0, bookPlaybackPercent(0, 10000))
        assertEquals(0, bookPlaybackPercent(99, 10000))
        assertEquals(42, bookPlaybackPercent(4299, 10000))
        assertEquals(99, bookPlaybackPercent(9999, 10000))
        assertEquals(100, bookPlaybackPercent(10000, 10000))
        assertEquals(0, bookPlaybackPercent(-1, 10000))
        assertEquals(100, bookPlaybackPercent(11000, 10000))
        assertEquals(0, bookPlaybackPercent(1, 0))
        assertEquals(0, bookPlaybackPercent(1, -1))
        assertEquals(100, bookPlaybackPercent(Int.MAX_VALUE, Int.MAX_VALUE))
    }

    @Test
    fun thumbTracksBothPlaybackAndUserScrubbingWithoutReplacingNativeSeek() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/books/BooksContent.kt").readText()
        assertTrue(source.contains("private val progress = SeekBar(context)"))
        assertTrue(source.contains("progress.thumb = progressThumb"))
        val listener = source.substringAfter("override fun onProgressChanged(seekBar: SeekBar, value: Int, fromUser: Boolean)")
            .substringBefore("override fun onStopTrackingTouch")
        assertTrue(listener.indexOf("progressThumb.updateProgress(value, seekBar.max)") in 0 until listener.indexOf("if (fromUser)"))
        assertTrue(source.contains("if (!scrubbing) {"))
        assertTrue(source.contains("playback.seek(it.durationMs * seekBar.progress / 10000)"))
    }
}
