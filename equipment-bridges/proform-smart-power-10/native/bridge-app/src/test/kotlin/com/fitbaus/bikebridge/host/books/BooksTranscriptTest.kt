// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.IOException

class BooksTranscriptTest {
    @Test
    fun webVttUsesBookRelativeHalfOpenIntervalsAcrossSeeksAndGaps() {
        val document = BooksTranscriptParser.parse("""WEBVTT

NOTE sample narration

cue-1
00:00:01.250 --> 00:00:04.000 align:center
First sentence.

00:00:04.000 --> 00:00:08.500
Second sentence.

01:02:03.000 --> 01:02:06.000
Later sentence.
""")
        assertNull(document.cueAt(0))
        assertNull(document.cueAt(1249))
        assertEquals("First sentence.", document.cueAt(1250)?.text)
        assertEquals("Second sentence.", document.cueAt(4000)?.text)
        assertNull(document.cueAt(8500))
        assertEquals("Later sentence.", document.cueAt(3_723_001)?.text)
        assertEquals("First sentence.", document.cueAt(2000)?.text)
        assertNull(document.cueAt(3_726_000))
    }

    @Test
    fun srtAcceptsBomCrLfMultilineTextAndPlainMarkup() {
        val text = "\uFEFF1\r\n00:00:00,000 --> 00:00:02,000\r\n<i>Hello</i> &amp; goodbye.\r\nNext line.\r\n"
        val document = BooksTranscriptParser.read(ByteArrayInputStream(text.toByteArray(Charsets.UTF_8)))
        assertEquals("Hello & goodbye.\nNext line.", document.cueAt(0)?.text)
        assertNull(document.cueAt(2000))
    }

    @Test
    fun vttSupportsMinuteOnlyTimestampsAndLongAudiobooks() {
        val document = BooksTranscriptParser.parse("""WEBVTT

00:00.000 --> 00:02.000
Beginning.

100:00:00.000 --> 100:00:01.000
Very long book.
""")
        assertEquals("Beginning.", document.cueAt(0)?.text)
        assertEquals("Very long book.", document.cueAt(360_000_000)?.text)
    }

    @Test
    fun rejectsMalformedEmptyReversedAndOverlappingCues() {
        val invalid = listOf(
            "",
            "WEBVTT\n",
            "00:00:01.000 --> 00:00:00.000\nReverse",
            "00:60:01.000 --> 00:60:02.000\nBad minutes",
            "00:00:00.000 --> 00:00:01.000\n",
            "00:00:00.000 --> 00:00:02.000\nOne\n\n00:00:01.000 --> 00:00:03.000\nTwo",
            "00:00:02.000 --> 00:00:03.000\nLater\n\n00:00:00.000 --> 00:00:01.000\nEarlier",
        )
        for (value in invalid) assertThrows(IllegalArgumentException::class.java) { BooksTranscriptParser.parse(value) }
        assertThrows(IOException::class.java) { BooksTranscriptParser.parse("00:00:00 --> 00:00:01\nBad stamp") }
    }

    @Test
    fun boundsInputAndCueSize() {
        assertThrows(IOException::class.java) {
            BooksTranscriptParser.read(ByteArrayInputStream(ByteArray(BooksTranscriptParser.MAX_BYTES + 1)))
        }
        assertThrows(IllegalArgumentException::class.java) {
            BooksTranscriptParser.parse("00:00:00.000 --> 00:00:01.000\n" + "a".repeat(BooksTranscript.MAX_CUE_CHARS + 1))
        }
    }

    @Test
    fun localSourceIdentityIsScopedToServerAndItemAndRejectsTraversal() {
        val first = BooksTranscriptRequest("http://192.168.1.193:13378", "book-1")
        val second = BooksTranscriptRequest("http://192.168.1.194:13378", "book-1")
        assertNotEquals(first.relativePath(), second.relativePath())
        assertNotEquals(first.relativePath(), first.copy(itemId = "book-2").relativePath())
        assertEquals(first.relativePath(), first.copy().relativePath())
        assertThrows(IllegalArgumentException::class.java) {
            first.copy(itemId = "../book")
        }
    }
}
