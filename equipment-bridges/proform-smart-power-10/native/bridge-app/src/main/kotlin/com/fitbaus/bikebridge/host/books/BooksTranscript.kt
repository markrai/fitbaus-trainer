// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException

internal data class BooksCue(val startMs: Long, val endMs: Long, val text: String)

internal class BooksTranscript(private val cues: List<BooksCue>, allowEmpty: Boolean = false) {
    init {
        require((allowEmpty || cues.isNotEmpty()) && cues.size <= MAX_CUES)
        require(cues.all { it.startMs >= 0 && it.endMs > it.startMs && it.endMs <= MAX_TIME_MS && it.text.isNotBlank() && it.text.length <= MAX_CUE_CHARS })
        require(cues.zipWithNext().all { (first, second) -> first.endMs <= second.startMs })
    }

    fun cueAt(positionMs: Long): BooksCue? {
        var low = 0
        var high = cues.lastIndex
        while (low <= high) {
            val middle = low + (high - low) / 2
            val cue = cues[middle]
            when {
                positionMs < cue.startMs -> high = middle - 1
                positionMs >= cue.endMs -> low = middle + 1
                else -> return cue
            }
        }
        return null
    }

    companion object {
        const val MAX_CUES = 30_000
        const val MAX_CUE_CHARS = 1200
        const val MAX_TIME_MS = 31_536_000_000L
    }
}

internal object BooksTranscriptParser {
    const val MAX_BYTES = 4 * 1024 * 1024
    private val timing = Regex("""^([^\s]+)\s+-->\s+([^\s]+)(?:\s+.*)?$""")
    private val stamp = Regex("""^(?:(\d{2,6}):)?(\d{2}):(\d{2})[.,](\d{3})$""")
    private val tag = Regex("""<[^>\n]{1,100}>""")

    fun read(input: InputStream): BooksTranscript {
        val bytes = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Transcript load cancelled")
            val count = input.read(buffer)
            if (count < 0) break
            if (bytes.size() + count > MAX_BYTES) throw IOException("Transcript exceeds size limit")
            bytes.write(buffer, 0, count)
        }
        val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString()
        return parse(text)
    }

    fun parse(text: String): BooksTranscript {
        require(text.length <= MAX_BYTES)
        val normalized = text.removePrefix("\uFEFF").replace("\r\n", "\n").replace('\r', '\n')
        val lines = normalized.lineSequence().iterator()
        val cues = ArrayList<BooksCue>()
        val block = ArrayList<String>()
        var firstBlock = true

        fun flush() {
            if (block.isEmpty()) return
            val first = block[0]
            when {
                firstBlock && (first == "WEBVTT" || first.startsWith("WEBVTT ") || first.startsWith("WEBVTT\t")) -> Unit
                first == "NOTE" || first.startsWith("NOTE ") || first.startsWith("NOTE\t") || first == "STYLE" || first == "REGION" -> Unit
                else -> {
                    val index = if (first.contains("-->")) 0 else 1
                    val match = block.getOrNull(index)?.let { timing.matchEntire(it.trim()) }
                        ?: throw IOException("Invalid transcript timing")
                    val start = time(match.groupValues[1])
                    val end = time(match.groupValues[2])
                    val body = block.drop(index + 1).joinToString("\n").replace(tag, "")
                        .replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").replace("&nbsp;", " ").trim()
                    require(cues.size < BooksTranscript.MAX_CUES)
                    cues.add(BooksCue(start, end, body))
                }
            }
            firstBlock = false
            block.clear()
        }

        while (lines.hasNext()) {
            if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Transcript load cancelled")
            val line = lines.next()
            if (line.isBlank()) flush() else {
                require(line.length <= 4096 && block.size < 128)
                block.add(line)
            }
        }
        flush()
        return BooksTranscript(cues)
    }

    private fun time(value: String): Long {
        val match = stamp.matchEntire(value) ?: throw IOException("Invalid transcript timestamp")
        val hours = match.groupValues[1].toLongOrNull() ?: 0
        val minutes = match.groupValues[2].toLong()
        val seconds = match.groupValues[3].toLong()
        require(minutes < 60 && seconds < 60)
        val result = ((hours * 60 + minutes) * 60 + seconds) * 1000 + match.groupValues[4].toLong()
        require(result <= BooksTranscript.MAX_TIME_MS)
        return result
    }
}
