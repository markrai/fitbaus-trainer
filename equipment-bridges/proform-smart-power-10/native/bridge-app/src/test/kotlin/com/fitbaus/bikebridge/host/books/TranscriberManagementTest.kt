package com.fitbaus.bikebridge.host.books

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TranscriberManagementTest {
    private val revision = "a".repeat(64)
    private val paired = TranscriberConnection("http://192.168.1.193:8765", "b".repeat(43))
    private val books = BooksConnection("http://192.168.1.193:13378", BooksCredentials("playback-access", "playback-refresh"))
    private val item = BooksItem("book", "Book", "Author", 650.0, 1)
    private val playback = BooksPlaybackSession("session", listOf(
        BooksAudioTrack("http://192.168.1.193:13378/api/items/book/file/123", 0, 650000)
    ), emptyList(), 0)
    private val identity = JSONObject().put("source_id", "home").put("item_id", "book").put("audio_revision", revision)
    private val manifest = JSONObject(identity.toString()).put("duration_ms", 650000)
        .put("tracks", JSONArray().put(JSONObject().put("file_id", "123").put("offset_ms", 0).put("duration_ms", 650000)))
    private val caps = JSONObject().put("api_version", 1).put("job_api", true)
        .put("source_id", "home").put("source_url", books.address)
        .put("paired_model_management", true).put("background_job_api", true)
        .put("background_job_lifetime_authorization", true).put("background_reauthorize", true)
        .put("model_qualification_api", true).put("models", JSONArray()
            .put(JSONObject().put("id", "tiny").put("installed", true).put("state", "installed"))
            .put(JSONObject().put("id", "base").put("installed", false).put("state", "not_installed").put("approximate_bytes", 148000000))
            .put(JSONObject().put("id", "small").put("installed", true).put("state", "installed")))
    private val qualification = JSONObject().put("models", JSONArray()
        .put(JSONObject().put("id", "tiny").put("admission", JSONObject().put("allowed", true)))
        .put(JSONObject().put("id", "small").put("qualification", JSONObject().put("state", "background_candidate"))
            .put("admission", JSONObject().put("allowed", true))))
    private val job = JSONObject(identity.toString()).put("job_id", "c".repeat(64)).put("model", "small")
        .put("state", "paused").put("processed_ms", 300000).put("total_ms", 650000)
    private val requests = mutableListOf<Triple<String, Map<String, String>, String?>>()

    private fun client(capabilities: JSONObject = caps): TranscriberManagement =
        TranscriberManagement(paired, books, item, playback, TranscriberHttp { url, headers, body ->
            val path = url.removePrefix(paired.address)
            requests.add(Triple(path, headers, body))
            assertEquals("Bearer ${paired.token}", headers["Authorization"])
            assertFalse(headers.values.contains("playback-refresh"))
            val response = when {
                path == "/v1/capabilities" -> capabilities
                path == "/v1/qualification" -> qualification
                path.endsWith("/manifest") -> manifest
                path == "/v1/items/book/background" -> JSONObject().put("jobs", JSONArray().put(job))
                path == "/v1/background" || path.endsWith("/resume") -> JSONObject(job.toString()).put("state", "queued")
                path.startsWith("/v1/background/") -> job
                path.startsWith("/v1/models/") -> JSONObject()
                else -> error("Unexpected path")
            }
            BooksHttpResponse(200, response.toString())
        })

    @Test
    fun modelInventoryAndJobProgress() {
        val result = client().snapshot()
        assertTrue(result.canManageModels)
        assertTrue(result.canPrepare)
        assertEquals(listOf("tiny", "base", "small"), result.models.map { it.id })
        assertFalse(result.models[1].installed)
        assertTrue(result.models[2].qualified)
        assertEquals(300000L, result.jobs.single().processed)
        assertTrue(result.jobs.single().canResume)
    }

    @Test
    fun startAndResumeUseExistingSessionWithoutSharingRefresh() {
        val api = client()
        api.download("base")
        assertEquals("/v1/models/base/download", requests.last().first)
        assertNull(requests.last().second["X-Audiobookshelf-Token"])
        assertEquals(job.getString("job_id"), api.start("small"))
        val submitted = requests.last()
        assertEquals("/v1/background", submitted.first)
        assertEquals("playback-access", submitted.second["X-Audiobookshelf-Token"])
        assertNull(submitted.second["X-FitBaus-Background-Refresh"])
        assertEquals(revision, JSONObject(requireNotNull(submitted.third)).getString("audio_revision"))
        assertEquals("small", JSONObject(requireNotNull(submitted.third)).getString("model"))
        val paused = api.snapshot().jobs.single()
        assertEquals(job.getString("job_id"), api.action(paused, "resume"))
        assertEquals("/v1/background/" + paused.id + "/resume", requests.last().first)
        assertEquals("playback-access", requests.last().second["X-Audiobookshelf-Token"])
        assertNull(requests.last().second["X-FitBaus-Background-Refresh"])
        assertEquals("playback-refresh", books.session.credentials().refreshToken)
    }

    @Test
    fun sourceMismatchDoesNotSendSourceCredentials() {
        val wrong = JSONObject(caps.toString()).put("source_url", "http://192.168.1.55:13378")
        val api = client(wrong)
        assertFalse(api.snapshot().canPrepare)
        assertThrows(IllegalArgumentException::class.java) {
            api.start("small")
        }
        assertTrue(requests.all { it.second["X-Audiobookshelf-Token"] == null })
    }

    @Test
    fun maintenanceOnlyReauthorizesWaitingJobsAndStopsOnPause() {
        val api = client()
        val id = job.getString("job_id")
        job.put("state", "waiting_credentials")
        assertTrue(api.maintain(id) { true })
        assertEquals("/v1/background/$id/reauthorize", requests.last().first)
        assertEquals("playback-access", requests.last().second["X-Audiobookshelf-Token"])
        assertNull(requests.last().second["X-FitBaus-Background-Refresh"])
        job.put("state", "paused")
        assertFalse(api.maintain(id) { true })
        assertEquals("/v1/background/$id", requests.last().first)
        val count = requests.size
        assertFalse(api.maintain(id) { false })
        assertEquals(count, requests.size)
    }

    @Test
    fun olderServerStillAcceptsExistingAccessTokenWithoutRenewal() {
        val oldCaps = JSONObject(caps.toString()).apply { remove("background_reauthorize") }
        assertNull(client(oldCaps).start("small"))
        assertEquals("playback-access", requests.last().second["X-Audiobookshelf-Token"])
        assertNull(requests.last().second["X-FitBaus-Background-Refresh"])
    }

    @Test
    fun automaticQualificationProgressAndRetry() {
        val modern = JSONObject(caps.toString()).put("automatic_model_qualification", true)
        qualification.getJSONArray("models").getJSONObject(1)
            .put("qualification", JSONObject().put("state", "unqualified"))
            .put("automatic", JSONObject().put("state", "running").put("completed_runs", 1).put("total_runs", 2))
        val api = client(modern)
        val snapshot = api.snapshot()
        assertTrue(snapshot.automaticQualification)
        val model = snapshot.models.last()
        assertTrue(model.qualifying)
        assertFalse(model.qualified)
        assertEquals(1, model.completedRuns)
        assertEquals(2, model.totalRuns)
        api.retryQualification("small")
        assertEquals("/v1/models/small/qualify", requests.last().first)
        assertNull(requests.last().second["X-Audiobookshelf-Token"])
        assertThrows(IllegalArgumentException::class.java) { client().retryQualification("small") }
    }

    @Test
    fun oldServerDoesNotPermitModelMutations() {
        val old = JSONObject(caps.toString()).put("paired_model_management", false)
            .put("background_job_lifetime_authorization", false)
        val api = client(old)
        assertFalse(api.snapshot().canPrepare)
        assertThrows(IllegalArgumentException::class.java) { api.download("base") }
        assertTrue(requests.none { it.first.startsWith("/v1/models/") })
    }
}
