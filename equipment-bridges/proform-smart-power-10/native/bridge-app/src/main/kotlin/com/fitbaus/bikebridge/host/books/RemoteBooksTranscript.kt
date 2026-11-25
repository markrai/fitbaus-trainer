package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import kotlin.math.abs

internal data class RemoteBooksWindow(
    val startMs: Long,
    val endMs: Long,
    val revision: String,
    val transcript: BooksTranscript,
    val summaryAvailable: Boolean = false,
    val sectionPlanAvailable: Boolean = false,
)

internal fun interface TranscriberHttp {
    fun request(url: String, headers: Map<String, String>, body: String?): BooksHttpResponse
}

internal class RemoteBooksTranscript(
    private val transcriber: TranscriberConnection,
    private val books: BooksConnection,
    private val http: TranscriberHttp = TranscriberHttp { url, headers, body ->
        val client = BooksUrlConnectionHttp()
        if (body == null) client.getWithHeaders(url, headers) else client.post(url, headers, body)
    },
    private val pause: () -> Unit = { Thread.sleep(2000) },
) {
    init {
        require(books.server.isCleartext || !transcriber.address.startsWith("http://", ignoreCase = true)) {
            "Use HTTPS for the transcriber when Audiobookshelf uses HTTPS."
        }
    }

    fun load(itemId: String, playback: BooksPlaybackSession, positionMs: Long, expectedRevision: String?, retry: Boolean): RemoteBooksWindow {
        require(itemId.matches(Regex("[A-Za-z0-9_-]{1,128}")))
        val capabilities = transcriber.test(BooksHttp { url, token ->
            http.request(url, mapOf("Authorization" to "Bearer $token"), null)
        })
        if (!capabilities.ready || capabilities.maxWindowMs < WINDOW_MS) throw IOException("Transcriber not ready or incompatible window size")
        requireMatchingSource(capabilities.sourceUrl)
        val sourceId = requireNotNull(capabilities.sourceId)
        val manifest = request("/v1/items/$itemId/manifest")
        require(manifest.getString("source_id") == sourceId && manifest.getString("item_id") == itemId)
        val revision = manifest.getString("audio_revision")
        require(revision.matches(Regex("[0-9a-f]{64}")))
        if (expectedRevision != null && expectedRevision != revision) throw IOException("Audiobook changed; reopen Read Along")
        val duration = integer(manifest, "duration_ms")
        require(duration in 1..BooksTranscript.MAX_TIME_MS && abs(duration - playback.durationMs) <= 1000)
        val tracks = manifest.getJSONArray("tracks")
        require(tracks.length() == playback.tracks.size)
        for (index in playback.tracks.indices) {
            val track = tracks.getJSONObject(index)
            val local = playback.tracks[index]
            require(track.getString("file_id") == local.url.substringAfterLast('/'))
            require(abs(integer(track, "offset_ms") - local.offsetMs) <= 1000)
            require(abs(integer(track, "duration_ms") - local.durationMs) <= 1000)
        }
        val start = windowStart(positionMs, playback.durationMs)
        require(start < duration)
        val end = minOf(start + WINDOW_MS, duration)
        val body = JSONObject().put("source_id", sourceId).put("item_id", itemId)
            .put("audio_revision", revision).put("start_ms", start).put("end_ms", end).put("retry", retry)
        val submitted = request("/v1/jobs", body.toString())
        var jobId = submitted.getString("job_id")
        require(jobId.matches(Regex("[0-9a-f]{64}")))
        fun validateJob(job: JSONObject, expectedId: String = jobId) {
            require(job.getString("job_id") == expectedId && job.getString("source_id") == sourceId &&
                job.getString("item_id") == itemId && job.getString("audio_revision") == revision &&
                integer(job, "start_ms") == start && integer(job, "end_ms") == end)
        }
        val deadline = System.nanoTime() + 120_000_000_000L
        var job = submitted
        var resubmitted = false
        while (true) {
            validateJob(job)
            when (job.getString("state")) {
                "ready" -> break
                "failed" -> throw IOException("Transcription failed; tap Reload to retry")
                "queued", "running" -> Unit
                else -> throw IOException("Invalid transcription job state")
            }
            if (System.nanoTime() >= deadline) throw IOException("Transcription is taking longer than expected; tap Reload")
            pause()
            job = if (!resubmitted && job.optString("dispatch") == "awaiting_credentials") {
                resubmitted = true
                val replacement = request("/v1/jobs", body.toString())
                val replacementId = replacement.getString("job_id")
                if (replacementId != jobId) {
                    require(replacementId.matches(Regex("[0-9a-f]{64}")))
                    require(replacement.getString("state") == "ready" && replacement.optBoolean("prepared"))
                    validateJob(replacement, replacementId)
                    jobId = replacementId
                }
                replacement
            } else request("/v1/jobs/$jobId")
        }
        val result = request("/v1/jobs/$jobId/transcript")
        require(result.getString("schema") == "fitbaus.transcript/v1" &&
            result.getString("source_id") == sourceId && result.getString("item_id") == itemId &&
            result.getString("audio_revision") == revision)
        val coverage = result.getJSONObject("coverage")
        require(integer(coverage, "start_ms") == start && integer(coverage, "end_ms") == end)
        val rows = result.getJSONArray("cues")
        require(rows.length() <= 5000)
        val cues = (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index)
            val cue = BooksCue(integer(row, "start_ms"), integer(row, "end_ms"), row.getString("text"))
            require(cue.startMs >= start && cue.endMs <= end)
            cue
        }
        return RemoteBooksWindow(start, end, revision, BooksTranscript(cues, allowEmpty = true),
            capabilities.summaryApi && capabilities.summaryProvider != null, capabilities.sectionPlanApi)
    }

    private fun requireMatchingSource(sourceUrl: String?) {
        if (sourceUrl == null || sourceUrl.trimEnd('/') != books.address.trimEnd('/')) {
            throw IOException("Transcriber Audiobookshelf source differs or is not advertised; check server version and Settings")
        }
    }

    private fun request(path: String, body: String? = null): JSONObject = books.session.authorized { sourceToken ->
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Transcript request cancelled")
        val headers = mapOf("Authorization" to "Bearer ${transcriber.token}", "X-Audiobookshelf-Token" to sourceToken)
        val response = http.request(transcriber.address + path, headers, body)
        if (response.status == 401) {
            val check = http.request(transcriber.address + "/v1/capabilities",
                mapOf("Authorization" to "Bearer ${transcriber.token}"), null)
            if (check.status != 200) throw IOException("Transcriber connection rejected; check Settings")
            requireMatchingSource(JSONObject(check.body).optString("source_url", "").takeIf { it.isNotBlank() })
            throw BooksHttpFailure(401)
        }
        if (response.status !in 200..299) throw IOException("Transcriber request failed (HTTP ${response.status})")
        JSONObject(response.body)
    }

    companion object {
        const val WINDOW_MS = 300_000L

        fun windowStart(positionMs: Long, durationMs: Long): Long {
            require(durationMs > 0)
            return positionMs.coerceIn(0, durationMs - 1) / WINDOW_MS * WINDOW_MS
        }

        private fun integer(json: JSONObject, key: String): Long {
            val value = json.get(key)
            require(value is Int || value is Long)
            return (value as Number).toLong()
        }
    }
}
