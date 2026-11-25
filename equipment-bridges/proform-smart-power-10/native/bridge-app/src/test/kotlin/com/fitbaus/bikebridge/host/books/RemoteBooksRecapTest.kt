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

class RemoteBooksRecapTest {
    private val revision = "a".repeat(64)
    private val digest = "b".repeat(64)
    private val paired = TranscriberConnection("http://192.168.1.193:8765", "c".repeat(43))
    private val books = BooksConnection("http://192.168.1.193:13378", "source-token")
    private val playback = BooksPlaybackSession("session", listOf(
        BooksAudioTrack(books.address + "/api/items/book/file/123", 0, 950_000)
    ), emptyList(), 0)
    private val selection = BooksRecapSelection("book", playback, 735_123, revision, 4)
    private val caps = JSONObject("""{"api_version":1,"transcript_schema":"fitbaus.transcript/v1","job_api":true,"source_configured":true,"source_id":"home","transcription":true,"engine_ready":true,"max_window_ms":300000,"summary_api":true,"recap_api":true,"summary_provider":{"configured":true,"protocol":"openai-chat/v1","model":"test-model"}}""")
        .put("source_url", books.address)
    private val manifest = JSONObject().put("source_id", "home").put("item_id", "book")
        .put("audio_revision", revision).put("duration_ms", 950_000)
        .put("tracks", JSONArray().put(JSONObject().put("file_id", "123").put("offset_ms", 0).put("duration_ms", 950_000)))

    private fun identity(selected: BooksRecapSelection = selection) =
        JSONObject().put("schema", "fitbaus.recap/v1").put("source_id", "home")
            .put("item_id", "book").put("audio_revision", revision).put("position_ms", selected.positionMs)
            .put("start_ms", selected.startMs).put("end_ms", selected.positionMs)

    private fun ready(selected: BooksRecapSelection = selection) = identity(selected)
        .put("state", "ready").put("summary", "Earlier narration.").put("model", "test-model")
        .put("prompt_version", "recap-v1").put("transcript_digest", digest).put("cache_hit", true)

    private fun client(capability: JSONObject = caps, response: (JSONObject) -> BooksHttpResponse) =
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
                url == paired.address + "/v1/recaps" -> {
                    assertEquals("source-token", headers["X-Audiobookshelf-Token"])
                    response(JSONObject(requireNotNull(body)))
                }
                else -> error("Unexpected route")
            }
        }, pause = {}, clock = { 0L })

    @Test
    fun recapUsesExactPositionAndRetriesOnlyFailedTranscriptOnce() {
        val requests = mutableListOf<JSONObject>()
        val pending = mutableListOf<BooksSummaryState.Pending>()
        val result = client { body ->
            requests.add(body)
            if (requests.size == 1) BooksHttpResponse(202, identity().put("state", "pending_transcript")
                .put("pending_windows", JSONArray(listOf(0, 300000, 600000))).toString())
            else BooksHttpResponse(200, ready().toString())
        }.loadRecap(selection, true) { pending.add(it) }
        assertEquals(BooksSummaryState.Ready(revision, "Earlier narration.", "test-model", "recap-v1", digest, true), result)
        assertEquals(2, requests.size)
        assertEquals(listOf(BooksSummaryState.Pending(revision, listOf(0L, 300_000L, 600_000L))), pending)
        for (body in requests) {
            assertEquals(setOf("source_id", "item_id", "audio_revision", "position_ms", "retry"), body.keys().asSequence().toSet())
            assertEquals(selection.positionMs, body.getLong("position_ms"))
            assertEquals(revision, body.getString("audio_revision"))
            assertEquals("home", body.getString("source_id"))
            assertEquals("book", body.getString("item_id"))
        }
        assertTrue(requests.first().getBoolean("retry"))
        assertFalse(requests.last().getBoolean("retry"))
    }

    @Test
    fun recapRejectsWrongSchemaCutoffIdentityAndPrompt() {
        for (invalid in listOf(
            ready().put("schema", "fitbaus.summary/v1"),
            ready().put("position_ms", selection.positionMs + 1),
            ready().put("end_ms", selection.positionMs + 1),
            ready().put("start_ms", selection.startMs - 1),
            ready().put("position_ms", selection.positionMs.toString()),
            ready().put("item_id", "other"),
            ready().put("audio_revision", "d".repeat(64)),
            ready().put("prompt_version", "section-v1"),
            ready().put("transcript_digest", "bad")
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                client { BooksHttpResponse(200, invalid.toString()) }.loadRecap(selection)
            }
        }
    }

    @Test
    fun recapRejectsFuturePendingWindow() {
        val result = identity().put("state", "pending_transcript").put("pending_windows", JSONArray(listOf(900000)))
        assertThrows(IllegalArgumentException::class.java) {
            client { BooksHttpResponse(202, result.toString()) }.loadRecap(selection)
        }
    }

    @Test
    fun recapAtStartCanOnlyBeEmpty() {
        val zero = selection.copy(positionMs = 0)
        val empty = ready(zero).put("state", "empty").put("summary", JSONObject.NULL)
        assertEquals(BooksSummaryState.Empty(revision),
            client { BooksHttpResponse(200, empty.toString()) }.loadRecap(zero))
        assertThrows(IllegalArgumentException::class.java) {
            client { BooksHttpResponse(200, ready(zero).toString()) }.loadRecap(zero)
        }
    }

    @Test
    fun recapCapabilityRequiresExplicitBooleanAndProviderAndMatchingSource() {
        for (capability in listOf(
            JSONObject(caps.toString()).apply { remove("recap_api") },
            JSONObject(caps.toString()).put("recap_api", "true"),
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
                remote.loadRecap(selection)
            }.failure)
            assertEquals(1, calls)
        }
    }

    @Test
    fun recapScopeSurvivesForwardPlaybackButNotSeekOrRevisionChange() {
        assertTrue(selection.matches("book", playback, revision, 4, 735_123))
        assertTrue(selection.matches("book", playback, revision, 4, 950_000))
        assertFalse(selection.matches("book", playback, revision, 4, 735_122))
        assertFalse(selection.matches("book", playback, revision, 5, 735_123))
        assertFalse(selection.matches("book", playback, revision, 5, 800_000))
        assertFalse(selection.matches("book", playback, "d".repeat(64), 4, 800_000))
        assertFalse(selection.matches("other", playback, revision, 4, 800_000))
        val replacement = BooksPlaybackSession("session", playback.tracks, emptyList(), 0)
        assertFalse(selection.matches("book", replacement, revision, 4, 800_000))
    }

    @Test
    fun recapPresentationShowsFixedRangeAndDistinctStates() {
        assertEquals("Up to 10 minutes · 0:02:15 – 0:12:15", BooksSummaryPresentation.recapRange(selection))
        assertEquals("Up to 10 minutes · 0:00:00 – 0:00:00", BooksSummaryPresentation.recapRange(selection.copy(positionMs = 0)))
        assertTrue(BooksSummaryPresentation.resolve(BooksSummaryState.Preparing, recap = true).text.contains("recap"))
        assertTrue(BooksSummaryPresentation.resolve(BooksSummaryState.Pending(revision, listOf(0L)), recap = true).text.contains("earlier narration"))
        assertTrue(BooksSummaryPresentation.resolve(BooksSummaryState.Empty(revision), recap = true).text.contains("before this position"))
    }
}
