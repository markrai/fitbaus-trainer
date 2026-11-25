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
import java.io.IOException

class RemoteBooksSectionPlanTest {
    private val revision = "a".repeat(64)
    private val paired = TranscriberConnection("http://192.168.1.193:8765", "c".repeat(43))
    private val books = BooksConnection("http://192.168.1.193:13378", "source-token")
    private val block = BooksSectionBlock(listOf(0L, 480_000L, 960_000L), null, 1, 2)
    private val refined = listOf(0L, 465_000L, 960_000L)
    private val caps = JSONObject("""{"api_version":1,"transcript_schema":"fitbaus.transcript/v1","job_api":true,"source_configured":true,"source_id":"home","transcription":true,"engine_ready":true,"max_window_ms":300000,"section_plan_api":true}""")
        .put("source_url", books.address)

    private fun result() = JSONObject().put("schema", "fitbaus.section-plan/v1")
        .put("algorithm", "sentence-pause-v1").put("source_id", "home")
        .put("item_id", "book").put("audio_revision", revision)
        .put("nominal_boundaries_ms", JSONArray(block.boundaries))
        .put("boundaries_ms", JSONArray(refined)).put("state", "refined")
        .put("reason", "sentence_or_pause").put("transcript_digest", "b".repeat(64))

    private fun client(capability: JSONObject = caps, response: JSONObject = result(), status: Int = 200,
                       onPost: (JSONObject) -> Unit = {}) =
        RemoteBooksSectionPlan(paired, books, TranscriberHttp { url, headers, body ->
            assertEquals("Bearer ${paired.token}", headers["Authorization"])
            if (url.endsWith("/v1/capabilities")) {
                assertNull(headers["X-Audiobookshelf-Token"])
                BooksHttpResponse(200, capability.toString())
            } else {
                assertEquals(paired.address + "/v1/section-plan", url)
                assertEquals("source-token", headers["X-Audiobookshelf-Token"])
                onPost(JSONObject(requireNotNull(body)))
                BooksHttpResponse(status, response.toString())
            }
        })

    @Test
    fun sendsOnlyIdentityAndNominalCutsAndAcceptsRefinement() {
        var posts = 0
        val remote = client(onPost = { request ->
            posts++
            assertEquals(setOf("source_id", "item_id", "audio_revision", "boundaries_ms"), request.keys().asSequence().toSet())
            assertEquals("home", request.getString("source_id"))
            assertEquals("book", request.getString("item_id"))
            assertEquals(revision, request.getString("audio_revision"))
            assertEquals(JSONArray(block.boundaries).toString(), request.getJSONArray("boundaries_ms").toString())
        })
        assertEquals(refined, remote.load("book", revision, block))
        assertEquals(1, posts)
    }

    @Test
    fun unsupportedOrWrongSourceDoesNotReceiveAudiobookshelfToken() {
        for (capability in listOf(
            JSONObject(caps.toString()).apply { remove("section_plan_api") },
            JSONObject(caps.toString()).put("section_plan_api", "true"),
            JSONObject(caps.toString()).put("source_url", "http://192.168.1.9:13378")
        )) {
            assertEquals(block.boundaries, client(capability = capability, onPost = { error("Unexpected POST") })
                .load("book", revision, block))
        }
        assertThrows(IllegalArgumentException::class.java) {
            RemoteBooksSectionPlan(paired, BooksConnection("https://books.example", "source-token"))
        }
    }

    @Test
    fun validatesNominalFallbackAndRejectsUnknownReason() {
        val nominal = result().put("boundaries_ms", JSONArray(block.boundaries)).put("state", "nominal")
            .put("reason", "missing_transcript").put("transcript_digest", JSONObject.NULL)
        assertEquals(block.boundaries, client(response = nominal).load("book", revision, block))
        assertThrows(IOException::class.java) {
            client(response = nominal.put("reason", "unknown")).load("book", revision, block)
        }
    }

    @Test
    fun rejectsChangedIdentityInvalidCutsAndMalformedDigest() {
        for (response in listOf(
            result().put("item_id", "other"), result().put("source_id", "other"),
            result().put("audio_revision", "d".repeat(64)), result().put("algorithm", "unknown"),
            result().put("nominal_boundaries_ms", JSONArray(listOf(0, 490000, 960000))),
            result().put("boundaries_ms", JSONArray(listOf(1, 465000, 960000))),
            result().put("boundaries_ms", JSONArray(listOf(0, 449999, 960000))),
            result().put("boundaries_ms", JSONArray(listOf(0, "465000", 960000))),
            result().put("transcript_digest", "bad"), result().put("state", "nominal")
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                client(response = response).load("book", revision, block)
            }
        }
        assertThrows(IOException::class.java) { client(status = 409).load("book", revision, block) }
    }

    @Test
    fun planningCapabilityIsStrictAndIndependentOfSummaryProvider() {
        fun parse(json: JSONObject) = paired.test(BooksHttp { _, _ -> BooksHttpResponse(200, json.toString()) })
        assertTrue(parse(caps).sectionPlanApi)
        assertNull(parse(caps).summaryProvider)
        assertFalse(parse(JSONObject(caps.toString()).put("section_plan_api", 1)).sectionPlanApi)
    }
}
