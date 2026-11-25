// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import kotlin.math.roundToLong

internal data class BooksAudioTrack(val url: String, val offsetMs: Long, val durationMs: Long)
internal data class BooksChapter(
    val title: String,
    val startMs: Long,
    val endMs: Long,
    val sourceId: Int?,
)
internal data class BooksTrackPosition(val index: Int, val positionMs: Long)

internal class BooksPlaybackSession(
    val id: String,
    val tracks: List<BooksAudioTrack>,
    val chapters: List<BooksChapter>,
    val resumeMs: Long,
) {
    val durationMs = tracks.last().offsetMs + tracks.last().durationMs

    fun locate(positionMs: Long): BooksTrackPosition {
        val position = positionMs.coerceIn(0, durationMs)
        val index = tracks.indexOfLast { it.offsetMs <= position }.coerceAtLeast(0)
        val track = tracks[index]
        return BooksTrackPosition(index, (position - track.offsetMs).coerceIn(0, track.durationMs))
    }

    fun position(index: Int, localMs: Long): Long {
        val track = tracks.getOrNull(index) ?: return 0
        return track.offsetMs + localMs.coerceIn(0, track.durationMs)
    }

    fun chapterAt(positionMs: Long): Int {
        val index = chapters.indexOfLast { it.startMs <= positionMs }
        return if (index >= 0 && positionMs < chapters[index].endMs) index else -1
    }
}

internal class BooksPlaybackApi(
    private val connection: BooksConnection,
    private val http: BooksAuthHttp = BooksUrlConnectionHttp(),
) {
    fun start(itemId: String, deviceId: String): BooksPlaybackSession {
        val device = JSONObject().put("deviceId", deviceId).put("clientName", "FitBaus").put("model", "FitBaus Bike")
        val body = JSONObject().put("forceDirectPlay", true).put("mediaPlayer", "FitBaus").put("deviceInfo", device)
        val json = JSONObject(post(connection.server.playUrl(itemId), body).body)
        val sessionId = json.getString("id")
        connection.server.sessionUrl(sessionId, true)
        try {
            return parse(connection.server, itemId, json)
        } catch (error: Exception) {
            runCatching { post(connection.server.sessionUrl(sessionId, true), JSONObject()) }
            throw error
        }
    }

    fun update(session: BooksPlaybackSession, positionMs: Long, listenedMs: Long, close: Boolean, includeProgress: Boolean = true) {
        val body = JSONObject()
        if (includeProgress) {
            body.put("currentTime", positionMs.coerceIn(0, session.durationMs) / 1000.0)
                .put("duration", session.durationMs / 1000.0)
                .put("timeListened", listenedMs.coerceAtLeast(0) / 1000.0)
        }
        post(connection.server.sessionUrl(session.id, close), body)
    }

    private fun post(url: String, body: JSONObject): BooksHttpResponse = connection.session.authorized { token ->
        val response = http.post(url, mapOf("Authorization" to "Bearer $token"), body.toString())
        if (response.status !in 200..299) throw BooksHttpFailure(response.status)
        response
    }

    companion object {
        fun parse(server: BooksServer, itemId: String, json: JSONObject): BooksPlaybackSession {
            val id = json.getString("id")
            server.sessionUrl(id, false)
            require(json.getString("libraryItemId") == itemId)
            require(json.optInt("playMethod", -1) == 0)
            val rows = json.getJSONArray("audioTracks")
            require(rows.length() in 1..1000)
            val tracks = (0 until rows.length()).map { index ->
                val row = rows.getJSONObject(index)
                BooksAudioTrack(server.audioUrl(itemId, row.getString("contentUrl")), ms(row.getDouble("startOffset")), ms(row.getDouble("duration")))
            }
            require(tracks.first().offsetMs == 0L)
            require(tracks.all { it.durationMs > 0 })
            require(tracks.zipWithNext().all { (a, b) ->
                b.offsetMs > a.offsetMs && kotlin.math.abs(b.offsetMs - a.offsetMs - a.durationMs) <= 1000
            })
            val duration = tracks.last().offsetMs + tracks.last().durationMs
            val chapters = normalizeChapters(json.optJSONArray("chapters"), duration)
            return BooksPlaybackSession(id, tracks, chapters, ms(json.optDouble("currentTime", 0.0)).coerceAtMost(duration))
        }

        private data class ChapterCandidate(
            val title: String,
            val startMs: Long,
            val endMs: Long?,
            val sourceId: Int?,
        )

        private fun normalizeChapters(rows: JSONArray?, durationMs: Long): List<BooksChapter> {
            if (rows == null) return emptyList()
            val durationSeconds = durationMs / 1000.0
            val candidates = (0 until minOf(rows.length(), 2000)).mapNotNull { index ->
                val row = rows.optJSONObject(index) ?: return@mapNotNull null
                val start = row.optDouble("start", -1.0)
                if (!start.isFinite() || start < 0 || start >= durationSeconds) return@mapNotNull null
                val startMs = (start * 1000).roundToLong()
                if (startMs >= durationMs) return@mapNotNull null
                val endMs = if (row.isNull("end")) null else {
                    val end = row.optDouble("end", -1.0)
                    if (!end.isFinite() || end <= start) return@mapNotNull null
                    val bounded = (minOf(end, durationSeconds) * 1000).roundToLong()
                    if (bounded <= startMs) return@mapNotNull null
                    bounded
                }
                val title = (row.opt("title") as? String)?.trim()?.take(200)?.takeIf { it.isNotBlank() }
                    ?: "Chapter ${index + 1}"
                val sourceId = row.optInt("id", -1).takeIf { it >= 0 }
                ChapterCandidate(title, startMs, endMs, sourceId)
            }.sortedBy { it.startMs }.distinctBy { it.startMs }

            return candidates.mapIndexed { index, chapter ->
                val nextStart = candidates.getOrNull(index + 1)?.startMs ?: durationMs
                BooksChapter(chapter.title, chapter.startMs, minOf(chapter.endMs ?: nextStart, nextStart), chapter.sourceId)
            }
        }

        private fun ms(seconds: Double): Long {
            if (!seconds.isFinite() || seconds !in 0.0..31_536_000.0) throw IOException("Invalid audiobook timing")
            return (seconds * 1000).roundToLong()
        }
    }
}
