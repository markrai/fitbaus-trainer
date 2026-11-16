// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube.media

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream

class YoutubeHttpDataSourceBoundsTest {
    @Test
    fun errorBodiesAreReadUpToTheLimitOnly() {
        var served = 0L
        val endless = object : InputStream() {
            override fun read(): Int {
                served += 1
                return 'x'.code
            }

            override fun read(b: ByteArray, off: Int, len: Int): Int {
                b.fill('x'.code.toByte(), off, off + len)
                served += len
                return len
            }
        }
        val body = YoutubeHttpDataSource.readBounded(endless, YoutubeHttpDataSource.MAX_ERROR_BODY_BYTES)
        assertEquals(64 * 1024, body.size)
        assertEquals(64 * 1024L, served, "nothing beyond the limit is pulled from the connection")
    }

    @Test
    fun shortBodiesAreReturnedWhole() {
        val text = "{\"error\":\"Forbidden\"}".toByteArray()
        assertArrayEquals(text, YoutubeHttpDataSource.readBounded(ByteArrayInputStream(text), YoutubeHttpDataSource.MAX_ERROR_BODY_BYTES))
        assertEquals(0, YoutubeHttpDataSource.readBounded(ByteArrayInputStream(ByteArray(0)), 16).size)
    }

    @Test
    fun theErrorStreamIsAlwaysClosedAndTheChangeIsAttributed() {
        val source = File("src/main/java/com/fitbaus/bikebridge/host/youtube/media/YoutubeHttpDataSource.java").readText()
        assertFalse(source.contains("Util.toByteArray(errorStream)"))
        val block = source.substring(source.indexOf("final InputStream errorStream"), source.indexOf("closeConnectionQuietly();", source.indexOf("final InputStream errorStream")))
        assertTrue(block.contains("readBounded(errorStream, MAX_ERROR_BODY_BYTES)"))
        assertTrue(block.contains("} finally {") && block.contains("closeQuietly(errorStream);"))
        assertTrue(source.contains("HTTP error bodies are read with a 64 KiB bound"), "the modification is recorded in the upstream header")
        assertTrue(source.contains("Original source code copyright (C) 2016 The Android Open Source Project"))
    }
}
