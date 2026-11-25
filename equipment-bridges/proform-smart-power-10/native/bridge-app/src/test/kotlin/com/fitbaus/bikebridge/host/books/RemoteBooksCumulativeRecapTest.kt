// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import com.sun.net.httpserver.HttpServer
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RemoteBooksCumulativeRecapTest {
    private val revision = "a".repeat(64)
    private val digest = "b".repeat(64)
    private val paired = TranscriberConnection("http://192.168.1.193:8765", "c".repeat(43))
    private val books = BooksConnection("http://192.168.1.193:13378", "source-token")
    private val playback = BooksPlaybackSession("session", listOf(
        BooksAudioTrack(books.address + "/api/items/book/file/123", 0, 950_000)
    ), emptyList(), 0)
    private val selection = BooksRecapSelection("book", playback, 735_123, revision, 4, cumulative = true)
    private val caps = JSONObject("""{"api_version":1,"transcript_schema":"fitbaus.transcript/v1","job_api":true,"source_configured":true,"source_id":"home","transcription":true,"engine_ready":true,"max_window_ms":300000,"summary_api":true,"recap_api":true,"cumulative_recap_api":true,"cumulative_recap_max_position_ms":86400000,"summary_provider":{"configured":true,"protocol":"openai-chat/v1","model":"test-model"}}""")
        .put("source_url", books.address)
    private val manifest = JSONObject().put("source_id", "home").put("item_id", "book")
        .put("audio_revision", revision).put("duration_ms", 950_000)
        .put("tracks", JSONArray().put(JSONObject().put("file_id", "123").put("offset_ms", 0).put("duration_ms", 950_000)))

    private fun identity(selected: BooksRecapSelection = selection) =
        JSONObject().put("schema", "fitbaus.cumulative-recap/v1").put("algorithm", "cumulative-v1")
            .put("source_id", "home").put("item_id", "book").put("audio_revision", revision)
            .put("position_ms", selected.positionMs).put("start_ms", 0).put("end_ms", selected.positionMs)

    private fun progress(completed: Int, total: Int = 3, selected: BooksRecapSelection = selection) =
        identity(selected).put("state", "pending_summary").put("model", "test-model")
            .put("prompt_version", "cumulative-v1").put("transcript_digest", digest)
            .put("completed_nodes", completed).put("total_nodes", total)

    private fun ready() = progress(3).put("state", "ready").put("summary", "Book so far.").put("cache_hit", false)

    private fun missing() = identity().put("state", "missing_transcript")
        .put("missing_window_count", 2).put("missing_windows", JSONArray(listOf(300000, 600000)))

    private fun client(capability: JSONObject = caps, pause: () -> Unit = {}, clock: () -> Long = { 0L },
                       response: (JSONObject) -> BooksHttpResponse) =
        RemoteBooksSummary(paired, books, TranscriberHttp { url, headers, body ->
            assertEquals("Bearer ${paired.token}", headers["Authorization"])
            when {
                url.endsWith("/v1/capabilities") -> {
                    assertNull(headers["X-Audiobookshelf-Token"])
                    BooksHttpResponse(200, capability.toString())
                }
                url.endsWith("/manifest") -> {
                    assertEquals("source-token", headers["X-Audiobookshelf-Token"])
                    BooksHttpResponse(200, manifest.toString())
                }
                url == paired.address + "/v1/cumulative-recaps" -> {
                    assertEquals("source-token", headers["X-Audiobookshelf-Token"])
                    response(JSONObject(requireNotNull(body)))
                }
                else -> error("Unexpected route")
            }
        }, pause, clock)

    @Test
    fun cumulativePollsExactPositionAndReportsProgress() {
        val requests = mutableListOf<JSONObject>()
        val states = mutableListOf<BooksSummaryState.Reducing>()
        val result = client { body ->
            requests.add(body)
            if (requests.size < 3) BooksHttpResponse(202, progress(requests.size).toString())
            else BooksHttpResponse(200, ready().toString())
        }.loadBookRecap(selection) { states.add(it) }
        assertEquals(BooksSummaryState.Ready(revision, "Book so far.", "test-model", "cumulative-v1", digest, false), result)
        assertEquals(listOf(BooksSummaryState.Reducing(revision, 1, 3), BooksSummaryState.Reducing(revision, 2, 3)), states)
        assertEquals(3, requests.size)
        for (body in requests) {
            assertEquals(setOf("source_id", "item_id", "audio_revision", "position_ms"), body.keys().asSequence().toSet())
            assertEquals(selection.positionMs, body.getLong("position_ms"))
            assertEquals(revision, body.getString("audio_revision"))
        }
    }

    @Test
    fun missingCoverageIsTerminalAndNotAnAutomaticRecentRecap() {
        var calls = 0
        val result = client {
            calls++
            BooksHttpResponse(409, missing().toString())
        }.loadBookRecap(selection) { error("Unexpected progress") }
        assertEquals(BooksSummaryState.MissingCoverage(revision, 2), result)
        assertEquals(1, calls)
        for (invalid in listOf(
            missing().put("missing_window_count", 4),
            missing().put("missing_windows", JSONArray(listOf(600000, 300000))),
            missing().put("missing_windows", JSONArray(listOf(300000, 900000))),
            missing().put("missing_windows", JSONArray(listOf(300000, 300000))),
            missing().put("summary", "Partial recap"),
            missing().put("position_ms", 735124)
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                client { BooksHttpResponse(409, invalid.toString()) }.loadBookRecap(selection)
            }
        }
        assertEquals(BooksSummaryFailure.BOOK_CHANGED_OR_TRANSCRIPT_FAILED,
            assertThrows(BooksSummaryException::class.java) {
                client { BooksHttpResponse(409, """{"error":"stale_revision"}""") }.loadBookRecap(selection)
            }.failure)
    }

    @Test
    fun actualHttpTransportPreservesCumulativeConflictBodyOnly() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        var conflict = missing().toString()
        server.createContext("/") { exchange ->
            exchange.requestBody.use { it.readBytes() }
            val (status, body) = when (exchange.requestURI.path) {
                "/v1/capabilities" -> 200 to caps.toString()
                "/v1/items/book/manifest" -> 200 to manifest.toString()
                "/v1/cumulative-recaps" -> 409 to conflict
                "/v1/recaps" -> 409 to conflict
                else -> 403 to "not authorized"
            }
            val bytes = body.toByteArray(Charsets.UTF_8)
            exchange.responseHeaders.set("Content-Type", "application/json")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val transport = booksSummaryHttp { url ->
                val path = URI(url).rawPath
                URI("http://127.0.0.1:${server.address.port}$path").toURL()
                    .openConnection(Proxy.NO_PROXY) as HttpURLConnection
            }
            val remote = RemoteBooksSummary(paired, books, transport, pause = {}, clock = { 0L })
            assertEquals(BooksSummaryState.MissingCoverage(revision, 2), remote.loadBookRecap(selection))
            assertEquals(BooksHttpResponse(409, ""), transport.request(paired.address + "/v1/recaps", emptyMap(), "{}"))
            assertEquals(BooksHttpResponse(403, ""), transport.request(paired.address + "/other", emptyMap(), "{}"))
            conflict = """{"error":"stale_revision"}"""
            assertEquals(BooksSummaryFailure.BOOK_CHANGED_OR_TRANSCRIPT_FAILED,
                assertThrows(BooksSummaryException::class.java) { remote.loadBookRecap(selection) }.failure)
            conflict = "x".repeat(16 * 1024 + 1)
            assertThrows(IOException::class.java) { remote.loadBookRecap(selection) }
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun rejectsWrongIdentityRangeAlgorithmAndProgress() {
        for (invalid in listOf(
            progress(0), progress(3), progress(2, 4), progress(1).put("completed_nodes", "1"),
            progress(1).put("algorithm", "unknown"), progress(1).put("transcript_digest", "bad"),
            progress(1).put("schema", "fitbaus.recap/v1"), progress(1).put("start_ms", 1),
            progress(1).put("end_ms", 735124), progress(1).put("model", "other"),
            progress(1).put("prompt_version", "recap-v1"), progress(1).put("summary", "Partial")
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                client { BooksHttpResponse(202, invalid.toString()) }.loadBookRecap(selection)
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            client { BooksHttpResponse(200, ready().put("completed_nodes", 2).toString()) }.loadBookRecap(selection)
        }
        assertThrows(IllegalArgumentException::class.java) {
            client { BooksHttpResponse(200, ready().apply { remove("cache_hit") }.toString()) }.loadBookRecap(selection)
        }
    }

    @Test
    fun requiresStrictCapabilityAndLimitBeforeSendingSourceCredential() {
        for (capability in listOf(
            JSONObject(caps.toString()).apply { remove("cumulative_recap_api") },
            JSONObject(caps.toString()).put("cumulative_recap_api", "true"),
            JSONObject(caps.toString()).put("cumulative_recap_max_position_ms", "86400000"),
            JSONObject(caps.toString()).put("cumulative_recap_max_position_ms", 86400001),
            JSONObject(caps.toString()).put("cumulative_recap_max_position_ms", 700000),
            JSONObject(caps.toString()).put("summary_provider", JSONObject().put("configured", false)),
            JSONObject(caps.toString()).put("source_url", "http://192.168.1.99:13378")
        )) {
            var calls = 0
            val remote = RemoteBooksSummary(paired, books, TranscriberHttp { url, headers, _ ->
                calls++
                assertEquals(paired.address + "/v1/capabilities", url)
                assertNull(headers["X-Audiobookshelf-Token"])
                BooksHttpResponse(200, capability.toString())
            })
            assertEquals(BooksSummaryFailure.UNAVAILABLE, assertThrows(BooksSummaryException::class.java) {
                remote.loadBookRecap(selection)
            }.failure)
            assertEquals(1, calls)
        }
    }

    @Test
    fun zeroPositionAndPresentationRemainExplicit() {
        val zero = selection.copy(positionMs = 0)
        val empty = progress(0, 0, zero).put("state", "empty").put("summary", JSONObject.NULL)
        assertEquals(BooksSummaryState.Empty(revision),
            client { BooksHttpResponse(200, empty.toString()) }.loadBookRecap(zero))
        assertEquals("From beginning · 0:00:00 – 0:12:15", BooksSummaryPresentation.recapRange(selection))
        val recent = selection.copy(cumulative = false)
        assertEquals("Up to 10 minutes · 0:02:15 – 0:12:15", BooksSummaryPresentation.recapRange(recent))
        assertEquals(selection.positionMs, recent.positionMs)
        assertTrue(BooksSummaryPresentation.resolve(BooksSummaryState.Reducing(revision, 1, 3), cumulative = true).text.contains("1 of 3"))
        val missingPresentation = BooksSummaryPresentation.resolve(BooksSummaryState.MissingCoverage(revision, 2), cumulative = true)
        assertTrue(missingPresentation.text.contains("2 missing windows"))
        assertFalse(missingPresentation.retry)
    }

    @Test
    fun pollingStopsAfterAdmissionBudgetWithoutRetryingAmbiguousFailures() {
        var now = 0L
        var calls = 0
        val remote = client(pause = { now = 1_800_000_000_000L }, clock = { now }) {
            calls++
            BooksHttpResponse(202, progress(1).toString())
        }
        assertEquals(BooksSummaryFailure.TIMEOUT, assertThrows(BooksSummaryException::class.java) {
            remote.loadBookRecap(selection)
        }.failure)
        assertEquals(1, calls)
        assertEquals(BooksSummaryFailure.BUSY, assertThrows(BooksSummaryException::class.java) {
            client { BooksHttpResponse(429, "") }.loadBookRecap(selection)
        }.failure)
    }
}
