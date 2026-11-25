// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import kotlin.math.abs

internal data class BooksSummarySelection(
    val itemId: String,
    val session: BooksPlaybackSession,
    val section: BooksSection,
    val expectedRevision: String?,
) {
    init {
        require(itemId.matches(Regex("[A-Za-z0-9_-]{1,128}")))
        require(section.endMs <= session.durationMs)
        require(expectedRevision == null || expectedRevision.matches(Regex("[0-9a-f]{64}")))
    }
}

internal data class BooksRecapSelection(
    val itemId: String,
    val session: BooksPlaybackSession,
    val positionMs: Long,
    val expectedRevision: String,
    val seekGeneration: Long,
    val cumulative: Boolean = false,
) {
    init {
        require(itemId.matches(Regex("[A-Za-z0-9_-]{1,128}")))
        require(positionMs in 0..session.durationMs)
        require(!cumulative || positionMs <= TranscriberConnection.MAX_CUMULATIVE_RECAP_MS)
        require(expectedRevision.matches(Regex("[0-9a-f]{64}")))
    }

    val startMs: Long get() = if (cumulative) 0L else maxOf(0L, positionMs - BooksSectionResolver.MAX_SECTION_MS)

    fun matches(item: String?, playback: BooksPlaybackSession?, revision: String?, seek: Long, position: Long): Boolean =
        itemId == item && session === playback && expectedRevision == revision &&
            seekGeneration == seek && position >= positionMs
}

internal class BooksSummaryScope {
    class Ticket(val selection: BooksSummarySelection)
    private var current: Ticket? = null
    private var observedRevision: String? = null
    val active: Boolean get() = current != null

    fun begin(selection: BooksSummarySelection): Ticket {
        observedRevision = selection.expectedRevision
        return Ticket(selection).also { current = it }
    }

    fun cancel() {
        current = null
        observedRevision = null
    }

    fun matches(selection: BooksSummarySelection?): Boolean {
        val original = current?.selection ?: return false
        return selection != null && original.itemId == selection.itemId && original.session === selection.session &&
            original.section == selection.section && (observedRevision == null || selection.expectedRevision == null ||
            observedRevision == selection.expectedRevision)
    }

    fun accepts(ticket: Ticket, selection: BooksSummarySelection?, revision: String? = null): Boolean {
        if (current !== ticket || !matches(selection)) return false
        if (revision != null) {
            if (observedRevision != null && observedRevision != revision) return false
            if (selection?.expectedRevision != null && selection.expectedRevision != revision) return false
            observedRevision = revision
        }
        return true
    }
}

internal enum class BooksSummaryFailure {
    UNAVAILABLE,
    AUTHORIZATION,
    BOOK_CHANGED_OR_TRANSCRIPT_FAILED,
    BUSY,
    TIMEOUT,
    NETWORK_OR_RESPONSE,
}

internal class BooksSummaryException(val failure: BooksSummaryFailure) : IOException(failure.name)

internal sealed class BooksSummaryState {
    open val revision: String? get() = null
    object Preparing : BooksSummaryState()
    data class Pending(override val revision: String, val windowStarts: List<Long>) : BooksSummaryState()
    data class Reducing(override val revision: String, val completedNodes: Int, val totalNodes: Int) : BooksSummaryState()
    data class MissingCoverage(override val revision: String, val missingWindowCount: Int) : BooksSummaryState()
    data class Ready(
        override val revision: String,
        val summary: String,
        val model: String,
        val promptVersion: String,
        val transcriptDigest: String,
        val cacheHit: Boolean?,
    ) : BooksSummaryState()
    data class Empty(override val revision: String) : BooksSummaryState()
    data class Failed(val failure: BooksSummaryFailure) : BooksSummaryState()
    object Cancelled : BooksSummaryState()
}

internal class RemoteBooksSummary(
    private val transcriber: TranscriberConnection,
    private val books: BooksConnection,
    private val http: TranscriberHttp = TranscriberHttp { url, headers, body ->
        val client = BooksUrlConnectionHttp(if (url.endsWith("/v1/summaries") || url.endsWith("/v1/recaps") || url.endsWith("/v1/cumulative-recaps")) 240_000 else 15_000)
        if (body == null) client.getWithHeaders(url, headers) else client.post(url, headers, body)
    },
    private val pause: () -> Unit = { Thread.sleep(4000) },
    private val clock: () -> Long = System::nanoTime,
) {
    init {
        require(books.server.isCleartext || !transcriber.address.startsWith("http://", ignoreCase = true))
    }

    fun load(selection: BooksSummarySelection, retryTranscript: Boolean = false,
             onPending: (BooksSummaryState.Pending) -> Unit = {}): BooksSummaryState =
        loadInterval(selection.itemId, selection.session, selection.expectedRevision,
            selection.section.startMs, selection.section.endMs, false, false, retryTranscript) {
            onPending(it as BooksSummaryState.Pending)
        }

    fun loadRecap(selection: BooksRecapSelection, retryTranscript: Boolean = false,
                  onPending: (BooksSummaryState) -> Unit = {}): BooksSummaryState =
        loadInterval(selection.itemId, selection.session, selection.expectedRevision,
            selection.startMs, selection.positionMs, true, selection.cumulative, retryTranscript, onPending)

    private fun loadInterval(itemId: String, session: BooksPlaybackSession, expectedRevision: String?,
                             startMs: Long, endMs: Long, recap: Boolean, cumulative: Boolean, retryTranscript: Boolean,
                             onPending: (BooksSummaryState) -> Unit): BooksSummaryState {
        val deadline = clock() + if (cumulative) 1_800_000_000_000L else 300_000_000_000L
        val attempts = if (cumulative) 300 else 76
        checkCancelled()
        val caps = capabilities(recap, cumulative)
        if (cumulative && endMs > (caps.cumulativeRecapMaxPositionMs ?: 0L)) {
            throw BooksSummaryException(BooksSummaryFailure.UNAVAILABLE)
        }
        val sourceId = caps.sourceId ?: throw BooksSummaryException(BooksSummaryFailure.UNAVAILABLE)
        val model = caps.summaryProvider?.model ?: throw BooksSummaryException(BooksSummaryFailure.UNAVAILABLE)
        val manifest = json(request("/v1/items/$itemId/manifest", null, sourceId, recap, cumulative), 200)
        require(manifest.getString("source_id") == sourceId && manifest.getString("item_id") == itemId)
        val revision = manifest.getString("audio_revision")
        require(DIGEST.matches(revision))
        if (expectedRevision != null && expectedRevision != revision) {
            throw BooksSummaryException(BooksSummaryFailure.BOOK_CHANGED_OR_TRANSCRIPT_FAILED)
        }
        val duration = integer(manifest, "duration_ms")
        require(duration in 1..BooksTranscript.MAX_TIME_MS && abs(duration - session.durationMs) <= 1000)
        require(endMs <= duration)
        val tracks = manifest.getJSONArray("tracks")
        require(tracks.length() == session.tracks.size)
        for (index in session.tracks.indices) {
            val track = tracks.getJSONObject(index)
            val local = session.tracks[index]
            require(track.getString("file_id") == local.url.substringAfterLast('/'))
            val offset = integer(track, "offset_ms")
            val trackDuration = integer(track, "duration_ms")
            require(offset in 0..BooksTranscript.MAX_TIME_MS && trackDuration in 1..BooksTranscript.MAX_TIME_MS)
            require(abs(offset - local.offsetMs) <= 1000)
            require(abs(trackDuration - local.durationMs) <= 1000)
        }
        val path = if (cumulative) "/v1/cumulative-recaps" else if (recap) "/v1/recaps" else "/v1/summaries"
        val schema = if (cumulative) "fitbaus.cumulative-recap/v1" else if (recap) "fitbaus.recap/v1" else "fitbaus.summary/v1"
        val body = JSONObject().put("source_id", sourceId).put("item_id", itemId).put("audio_revision", revision)
        if (recap) body.put("position_ms", endMs) else body.put("start_ms", startMs).put("end_ms", endMs)
        val required = if (startMs == endMs) emptyList() else {
            val window = RemoteBooksTranscript.WINDOW_MS
            (startMs / window * window..(endMs - 1) / window * window step window).toList()
        }
        var retry = retryTranscript
        repeat(attempts) { attempt ->
            checkCancelled()
            if (clock() - deadline >= 0) throw BooksSummaryException(BooksSummaryFailure.TIMEOUT)
            if (!cumulative) body.put("retry", retry)
            val response = request(path, body.toString(), sourceId, recap, cumulative)
            retry = false
            checkCancelled()
            val result = if (cumulative && response.status == 409 &&
                runCatching { JSONObject(response.body).opt("state") == "missing_transcript" }.getOrDefault(false)) {
                JSONObject(response.body)
            } else json(response, 200, 202)
            require(result.opt("schema") == schema && result.opt("source_id") == sourceId &&
                result.opt("item_id") == itemId && result.opt("audio_revision") == revision &&
                integer(result, "start_ms") == startMs && integer(result, "end_ms") == endMs)
            if (recap) require(integer(result, "position_ms") == endMs)
            if (cumulative) {
                require(result.opt("algorithm") == "cumulative-v1")
                if (response.status == 409) {
                    val count = integer(result, "missing_window_count")
                    require(count in 1L..required.size.toLong())
                    val rows = result.getJSONArray("missing_windows")
                    require(rows.length() == minOf(16L, count).toInt())
                    val starts = (0 until rows.length()).map { strictInteger(rows.get(it)) }
                    require(starts == starts.distinct().sorted() && starts.all { it in required })
                    return BooksSummaryState.MissingCoverage(revision, count.toInt())
                }
                require(result.opt("model") == model && result.opt("prompt_version") == "cumulative-v1")
                require(DIGEST.matches(result.opt("transcript_digest") as? String ?: ""))
                val total = integer(result, "total_nodes")
                val completed = integer(result, "completed_nodes")
                require(total == cumulativeNodeCount(endMs).toLong() && completed in 0..total)
                if (result.opt("state") == "pending_summary") {
                    require(response.status == 202 && completed in 1 until total && !result.has("summary"))
                    onPending(BooksSummaryState.Reducing(revision, completed.toInt(), total.toInt()))
                    if (attempt == attempts - 1 || clock() - deadline >= 0) throw BooksSummaryException(BooksSummaryFailure.TIMEOUT)
                    pause()
                    return@repeat
                }
                require(response.status == 200 && completed == total)
            }
            when (result.opt("state")) {
                "pending_transcript" -> {
                    require(!cumulative && response.status == 202)
                    val rows = result.getJSONArray("pending_windows")
                    require(rows.length() in 1..required.size)
                    val starts = (0 until rows.length()).map { index -> strictInteger(rows.get(index)) }
                    require(starts == starts.distinct().sorted() && starts.all { it in required })
                    onPending(BooksSummaryState.Pending(revision, starts))
                    if (attempt == attempts - 1 || clock() - deadline >= 0) throw BooksSummaryException(BooksSummaryFailure.TIMEOUT)
                    pause()
                }
                "ready", "empty" -> {
                    require(response.status == 200 && result.opt("model") == model)
                    val prompt = result.opt("prompt_version") as? String ?: error("Invalid prompt version")
                    val digest = result.opt("transcript_digest") as? String ?: error("Invalid transcript digest")
                    require(PROMPT.matches(prompt) && DIGEST.matches(digest))
                    if (recap && !cumulative) require(prompt == "recap-v1")
                    if (result.opt("state") == "empty") {
                        require(result.has("summary") && result.isNull("summary"))
                        return BooksSummaryState.Empty(revision)
                    }
                    require(startMs < endMs)
                    val summary = result.opt("summary") as? String ?: error("Invalid summary")
                    require(summary.isNotBlank() && summary.codePointCount(0, summary.length) <= 8000)
                    if (cumulative) require(summary.toByteArray(Charsets.UTF_8).size <= 12 * 1024)
                    val cacheHit = if (result.has("cache_hit")) {
                        require(result.opt("cache_hit") is Boolean)
                        result.getBoolean("cache_hit")
                    } else null
                    return BooksSummaryState.Ready(revision, summary, model, prompt, digest, cacheHit)
                }
                else -> throw BooksSummaryException(BooksSummaryFailure.NETWORK_OR_RESPONSE)
            }
        }
        throw BooksSummaryException(BooksSummaryFailure.TIMEOUT)
    }

    private fun cumulativeNodeCount(positionMs: Long): Int {
        var level = ((positionMs + BooksSectionResolver.MAX_SECTION_MS - 1) / BooksSectionResolver.MAX_SECTION_MS).toInt()
        var total = level
        while (level > 1) {
            total += level / 4 + if (level % 4 >= 2) 1 else 0
            level = (level + 3) / 4
        }
        return total
    }

    private fun capabilities(recap: Boolean, cumulative: Boolean): TranscriberCapabilities {
        checkCancelled()
        val caps = transcriber.test(BooksHttp { url, token ->
            val response = try {
                http.request(url, mapOf("Authorization" to "Bearer $token"), null)
            } catch (_: SocketTimeoutException) {
                throw BooksSummaryException(BooksSummaryFailure.TIMEOUT)
            }
            if (response.status == 401) throw BooksSummaryException(BooksSummaryFailure.AUTHORIZATION)
            response
        })
        val available = if (cumulative) caps.cumulativeRecapMaxPositionMs != null else if (recap) caps.recapApi else caps.summaryApi
        if (caps.sourceUrl?.trimEnd('/') != books.address.trimEnd('/') || !available || caps.summaryProvider == null) {
            throw BooksSummaryException(BooksSummaryFailure.UNAVAILABLE)
        }
        return caps
    }

    private fun request(path: String, body: String?, sourceId: String, recap: Boolean, cumulative: Boolean): BooksHttpResponse {
        try {
            return books.session.authorized { sourceToken ->
                checkCancelled()
                val response = http.request(transcriber.address + path,
                    mapOf("Authorization" to "Bearer ${transcriber.token}", "X-Audiobookshelf-Token" to sourceToken), body)
                checkCancelled()
                if (response.status == 401) {
                    val caps = capabilities(recap, cumulative)
                    if (caps.sourceId != sourceId) throw BooksSummaryException(BooksSummaryFailure.AUTHORIZATION)
                    throw BooksHttpFailure(401)
                }
                response
            }
        } catch (error: BooksHttpFailure) {
            if (error.status == 401) throw BooksSummaryException(BooksSummaryFailure.AUTHORIZATION)
            throw error
        } catch (_: SocketTimeoutException) {
            throw BooksSummaryException(BooksSummaryFailure.TIMEOUT)
        }
    }

    private fun json(response: BooksHttpResponse, vararg statuses: Int): JSONObject {
        if (response.status !in statuses) throw BooksSummaryException(when (response.status) {
            401, 403 -> BooksSummaryFailure.AUTHORIZATION
            404, 503 -> BooksSummaryFailure.UNAVAILABLE
            409 -> BooksSummaryFailure.BOOK_CHANGED_OR_TRANSCRIPT_FAILED
            429 -> BooksSummaryFailure.BUSY
            408, 504 -> BooksSummaryFailure.TIMEOUT
            else -> BooksSummaryFailure.NETWORK_OR_RESPONSE
        })
        return JSONObject(response.body)
    }

    private fun checkCancelled() {
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Summary cancelled")
    }

    private fun integer(json: JSONObject, key: String): Long = strictInteger(json.get(key))

    private fun strictInteger(value: Any): Long {
        require(value is Int || value is Long)
        return (value as Number).toLong()
    }

    private companion object {
        val DIGEST = Regex("[0-9a-f]{64}")
        val PROMPT = Regex("[A-Za-z0-9._-]{1,64}")
    }
}
