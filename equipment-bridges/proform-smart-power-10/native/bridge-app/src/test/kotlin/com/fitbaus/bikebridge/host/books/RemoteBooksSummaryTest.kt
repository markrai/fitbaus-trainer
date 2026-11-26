// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.SocketTimeoutException

class RemoteBooksSummaryTest {
    private val revision = "a".repeat(64)
    private val digest = "b".repeat(64)
    private val paired = TranscriberConnection("http://192.168.1.193:8765", "c".repeat(43))
    private val books = BooksConnection("http://192.168.1.193:13378", "source-token")
    private val playback = BooksPlaybackSession("session", listOf(
        BooksAudioTrack(books.address + "/api/items/book/file/123", 0, 650_000)
    ), emptyList(), 0)
    private val section = BooksSection(100_000, 700_000 - 50_000, null, 1, 1)
    private val selection = BooksSummarySelection("book", playback, section, revision)
    private val capabilities = JSONObject("""{"api_version":1,"transcript_schema":"fitbaus.transcript/v1","job_api":true,"source_configured":true,"source_id":"home","transcription":true,"engine_ready":true,"max_window_ms":300000,"summary_api":true,"summary_provider":{"configured":true,"protocol":"openai-chat/v1","model":"test-model"}}""")
        .put("source_url", books.address)
    private val manifest = JSONObject().put("source_id", "home").put("item_id", "book")
        .put("audio_revision", revision).put("duration_ms", 650_000)
        .put("tracks", JSONArray().put(JSONObject().put("file_id", "123").put("offset_ms", 0).put("duration_ms", 650_000)))

    private fun identity() = JSONObject().put("schema", "fitbaus.summary/v1").put("source_id", "home")
        .put("item_id", "book").put("audio_revision", revision)
        .put("start_ms", section.startMs).put("end_ms", section.endMs)

    private fun ready() = identity().put("state", "ready").put("summary", "A summary.")
        .put("model", "test-model").put("prompt_version", "section-v1").put("transcript_digest", digest)
        .put("cache_hit", true)

    private fun pending() = identity().put("state", "pending_transcript").put("pending_windows", JSONArray(listOf(0, 300_000, 600_000)))

    private fun client(
        caps: JSONObject = capabilities,
        metadata: JSONObject = manifest,
        pause: () -> Unit = {},
        clock: () -> Long = { 0L },
        summary: (JSONObject) -> BooksHttpResponse,
    ) = RemoteBooksSummary(paired, books, TranscriberHttp { url, headers, body ->
        assertEquals("Bearer ${paired.token}", headers["Authorization"])
        when {
            url.endsWith("/v1/capabilities") -> {
                assertNull(headers["X-Audiobookshelf-Token"])
                BooksHttpResponse(200, caps.toString())
            }
            url.endsWith("/manifest") -> {
                assertEquals("source-token", headers["X-Audiobookshelf-Token"])
                BooksHttpResponse(200, metadata.toString())
            }
            url == paired.address + "/v1/summaries" -> {
                assertEquals("source-token", headers["X-Audiobookshelf-Token"])
                summary(JSONObject(requireNotNull(body)))
            }
            else -> error("Unexpected route")
        }
    }, pause, clock)

    @Test
    fun pendingThenReadyUsesOnlyIdentityAndExplicitRetryOnce() {
        val requests = mutableListOf<JSONObject>()
        val pendingStates = mutableListOf<BooksSummaryState.Pending>()
        val result = client { body ->
            requests.add(body)
            if (requests.size == 1) BooksHttpResponse(202, pending().toString())
            else BooksHttpResponse(200, ready().toString())
        }.load(selection, true) { pendingStates.add(it) }
        assertEquals(BooksSummaryState.Ready(revision, "A summary.", "test-model", "section-v1", digest, true, "home"), result)
        assertEquals(listOf(BooksSummaryState.Pending(revision, listOf(0L, 300_000L, 600_000L))), pendingStates)
        assertEquals(2, requests.size)
        for (request in requests) {
            assertEquals(setOf("source_id", "item_id", "audio_revision", "start_ms", "end_ms", "retry"), request.keys().asSequence().toSet())
            assertEquals("home", request.getString("source_id"))
            assertEquals("book", request.getString("item_id"))
            assertEquals(revision, request.getString("audio_revision"))
            assertEquals(section.startMs, request.getLong("start_ms"))
            assertEquals(section.endMs, request.getLong("end_ms"))
        }
        assertTrue(requests[0].getBoolean("retry"))
        assertFalse(requests[1].getBoolean("retry"))
    }

    @Test
    fun emptyAndLegacyCacheFieldAreAccepted() {
        val empty = ready().put("state", "empty").put("summary", JSONObject.NULL).apply { remove("cache_hit") }
        assertEquals(BooksSummaryState.Empty(revision), client { BooksHttpResponse(200, empty.toString()) }.load(selection))
        val old = ready().apply { remove("cache_hit") }
        assertNull((client { BooksHttpResponse(200, old.toString()) }.load(selection) as BooksSummaryState.Ready).cacheHit)
    }

    @Test
    fun missingApiOrProviderAndWrongSourceNeverReceiveSourceCredential() {
        for (caps in listOf(
            JSONObject(capabilities.toString()).apply { remove("summary_api") },
            JSONObject(capabilities.toString()).put("summary_api", "true"),
            JSONObject(capabilities.toString()).put("summary_provider", JSONObject().put("configured", false)),
            JSONObject(capabilities.toString()).put("source_url", "http://192.168.1.99:13378")
        )) {
            var calls = 0
            val remote = RemoteBooksSummary(paired, books, TranscriberHttp { url, headers, _ ->
                calls++
                assertEquals(paired.address + "/v1/capabilities", url)
                assertNull(headers["X-Audiobookshelf-Token"])
                BooksHttpResponse(200, caps.toString())
            })
            assertEquals(BooksSummaryFailure.UNAVAILABLE, assertThrows(BooksSummaryException::class.java) {
                remote.load(selection)
            }.failure)
            assertEquals(1, calls)
        }
    }

    @Test
    fun staleManifestAndMismatchedTracksStopBeforePost() {
        assertEquals(BooksSummaryFailure.BOOK_CHANGED_OR_TRANSCRIPT_FAILED, assertThrows(BooksSummaryException::class.java) {
            client(metadata = JSONObject(manifest.toString()).put("audio_revision", "d".repeat(64))) { error("Unexpected POST") }.load(selection)
        }.failure)
        val mismatch = JSONObject(manifest.toString())
        mismatch.getJSONArray("tracks").getJSONObject(0).put("file_id", "different")
        assertThrows(IllegalArgumentException::class.java) {
            client(metadata = mismatch) { error("Unexpected POST") }.load(selection)
        }
        assertThrows(IllegalArgumentException::class.java) {
            RemoteBooksSummary(paired, BooksConnection("https://books.example", "source-token"))
        }
    }

    @Test
    fun rejectsWrongIdentityIntervalModelAndPendingCoverage() {
        for (invalid in listOf(
            ready().put("item_id", "other"), ready().put("audio_revision", "d".repeat(64)),
            ready().put("end_ms", section.endMs - 1), ready().put("start_ms", "100000"),
            ready().put("model", "another-model"), ready().put("transcript_digest", "bad"),
            ready().put("summary", "x".repeat(8001)), ready().put("cache_hit", "true")
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                client { BooksHttpResponse(200, invalid.toString()) }.load(selection)
            }
        }
        for (invalid in listOf(JSONArray(listOf(900_000)), JSONArray(listOf(0, 0)), JSONArray(), JSONArray(listOf("0")))) {
            assertThrows(IllegalArgumentException::class.java) {
                client { BooksHttpResponse(202, pending().put("pending_windows", invalid).toString()) }.load(selection)
            }
        }
    }

    @Test
    fun pendingTimeoutAndAmbiguousTransportFailureDoNotResubmitAutomatically() {
        var now = 0L
        var calls = 0
        val remote = client(pause = { now = 301_000_000_000L }, clock = { now }) {
            calls++
            BooksHttpResponse(202, pending().toString())
        }
        assertEquals(BooksSummaryFailure.TIMEOUT, assertThrows(BooksSummaryException::class.java) { remote.load(selection) }.failure)
        assertEquals(1, calls)
        val timeout = client {
            calls++
            throw SocketTimeoutException()
        }
        assertEquals(BooksSummaryFailure.TIMEOUT, assertThrows(BooksSummaryException::class.java) { timeout.load(selection) }.failure)
        assertEquals(2, calls)
        val busy = client { BooksHttpResponse(429, "") }
        assertEquals(BooksSummaryFailure.BUSY, assertThrows(BooksSummaryException::class.java) { busy.load(selection) }.failure)
    }

    @Test
    fun scopeRejectsReplacedRequestsNewSessionSectionAndRevision() {
        val scope = BooksSummaryScope()
        val first = scope.begin(selection)
        assertTrue(scope.accepts(first, selection, revision))
        val replacement = scope.begin(selection)
        assertFalse(scope.accepts(first, selection, revision))
        assertTrue(scope.accepts(replacement, selection))
        assertFalse(scope.accepts(replacement, selection.copy(section = section.copy(startMs = 110_000))))
        assertFalse(scope.accepts(replacement, selection.copy(itemId = "other")))
        val newSession = BooksPlaybackSession("session", playback.tracks, emptyList(), 0)
        assertFalse(scope.accepts(replacement, selection.copy(session = newSession)))
        assertFalse(scope.accepts(replacement, selection.copy(expectedRevision = "d".repeat(64))))
        scope.cancel()
        assertFalse(scope.accepts(replacement, selection))
        val unknown = scope.begin(selection.copy(expectedRevision = null))
        assertTrue(scope.accepts(unknown, selection.copy(expectedRevision = null), revision))
        assertFalse(scope.matches(selection.copy(expectedRevision = "d".repeat(64))))
        assertFalse(scope.accepts(unknown, selection, "d".repeat(64)))
    }

    @Test
    fun audioRevisionLearnedDuringRequestMustMatchResponse() {
        val scope = BooksSummaryScope()
        val unknown = scope.begin(selection.copy(expectedRevision = null))
        assertFalse(scope.accepts(unknown, selection, "d".repeat(64)))
        assertTrue(scope.accepts(unknown, selection, revision))
    }
}
