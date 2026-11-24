package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.io.IOException

class RemoteBooksTranscriptTest {
    private val revision = "a".repeat(64)
    private val jobId = "b".repeat(64)
    private val token = "c".repeat(43)
    private val paired = TranscriberConnection("http://192.168.1.193:8765", token)
    private val books = BooksConnection("http://192.168.1.193:13378", "source-token")
    private val playback = BooksPlaybackSession("session", listOf(
        BooksAudioTrack("http://192.168.1.193:13378/api/items/book/file/123", 0, 650000)
    ), emptyList(), 0)
    private val capabilities = """{"api_version":1,"transcript_schema":"fitbaus.transcript/v1","job_api":true,"source_configured":true,"source_id":"home","transcription":true,"engine_ready":true,"max_window_ms":300000}"""
    private val identity = JSONObject().put("source_id", "home").put("item_id", "book").put("audio_revision", revision)
    private val manifest = JSONObject(identity.toString()).put("duration_ms", 650000)
        .put("tracks", org.json.JSONArray().put(JSONObject().put("file_id", "123").put("offset_ms", 0).put("duration_ms", 650000)))
    private val job = JSONObject(identity.toString()).put("job_id", jobId).put("start_ms", 300000).put("end_ms", 600000)
    private val result = JSONObject(identity.toString()).put("schema", "fitbaus.transcript/v1")
        .put("coverage", JSONObject().put("start_ms", 300000).put("end_ms", 600000))
        .put("cues", org.json.JSONArray().put(JSONObject().put("start_ms", 301000).put("end_ms", 303000).put("text", "Narration")))

    private fun client(transcript: JSONObject = result, metadata: JSONObject = manifest, failed: Boolean = false): RemoteBooksTranscript =
        RemoteBooksTranscript(paired, books, TranscriberHttp { url, headers, body ->
            assertEquals("Bearer $token", headers["Authorization"])
            if (url.endsWith("/v1/capabilities")) {
                assertEquals(null, headers["X-Audiobookshelf-Token"])
                BooksHttpResponse(200, capabilities)
            } else {
                assertEquals("source-token", headers["X-Audiobookshelf-Token"])
                when {
                    url.endsWith("/manifest") -> BooksHttpResponse(200, metadata.toString())
                    url.endsWith("/v1/jobs") -> {
                        val submitted = JSONObject(requireNotNull(body))
                        assertEquals(300000L, submitted.getLong("start_ms"))
                        assertEquals(600000L, submitted.getLong("end_ms"))
                        assertEquals(revision, submitted.getString("audio_revision"))
                        BooksHttpResponse(202, JSONObject(job.toString()).put("state", "queued").toString())
                    }
                    url.endsWith("/transcript") -> BooksHttpResponse(200, transcript.toString())
                    else -> {
                        assertEquals(paired.address + "/v1/jobs/" + jobId, url)
                        BooksHttpResponse(200, JSONObject(job.toString()).put("state", if (failed) "failed" else "ready").toString())
                    }
                }
            }
        }, pause = {})

    @Test
    fun alignsWindowsAndUsesActualPlaybackPosition() {
        assertEquals(0L, RemoteBooksTranscript.windowStart(299999, 650000))
        assertEquals(300000L, RemoteBooksTranscript.windowStart(300000, 650000))
        assertEquals(600000L, RemoteBooksTranscript.windowStart(650000, 650000))
        val window = client().load("book", playback, 301500, null, false)
        assertEquals(revision, window.revision)
        assertEquals("Narration", window.transcript.cueAt(301500)?.text)
        assertNull(window.transcript.cueAt(303000))
    }

    @Test
    fun silenceIsAValidWindow() {
        val silent = JSONObject(result.toString()).put("cues", org.json.JSONArray())
        assertNull(client(silent).load("book", playback, 301500, null, false).transcript.cueAt(301500))
    }

    @Test
    fun mismatchesAreRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            client(JSONObject(result.toString()).put("item_id", "wrong")).load("book", playback, 301500, null, false)
        }
        assertThrows(IllegalArgumentException::class.java) {
            client(metadata = JSONObject(manifest.toString()).put("duration_ms", 900000)).load("book", playback, 301500, null, false)
        }
        assertThrows(IOException::class.java) {
            client().load("book", playback, 301500, "d".repeat(64), false)
        }
        assertThrows(IOException::class.java) {
            client(failed = true).load("book", playback, 301500, null, false)
        }
    }

    @Test
    fun preventsDowngradingSourceCredentialsToHttp() {
        assertThrows(IllegalArgumentException::class.java) {
            RemoteBooksTranscript(paired, BooksConnection("https://books.example", "source-token"))
        }
    }
}
