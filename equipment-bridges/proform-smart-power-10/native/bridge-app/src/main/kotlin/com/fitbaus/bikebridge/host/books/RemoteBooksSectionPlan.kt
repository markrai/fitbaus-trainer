// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException

internal class RemoteBooksSectionPlan(
    private val transcriber: TranscriberConnection,
    private val books: BooksConnection,
    private val http: TranscriberHttp = TranscriberHttp { url, headers, body ->
        val client = BooksUrlConnectionHttp()
        if (body == null) client.getWithHeaders(url, headers) else client.post(url, headers, body)
    },
) {
    init { require(books.server.isCleartext || !transcriber.address.startsWith("http://", ignoreCase = true)) }

    fun load(itemId: String, revision: String, block: BooksSectionBlock): List<Long> {
        require(BooksIdentifier.isValid(itemId) && DIGEST.matches(revision))
        val sourceId = source() ?: return block.boundaries
        val body = JSONObject().put("source_id", sourceId).put("item_id", itemId)
            .put("audio_revision", revision).put("boundaries_ms", JSONArray(block.boundaries)).toString()
        val response = books.session.authorized { token ->
            checkCancelled()
            val result = http.request(transcriber.address + "/v1/section-plan", mapOf(
                "Authorization" to "Bearer ${transcriber.token}", "X-Audiobookshelf-Token" to token), body)
            checkCancelled()
            if (result.status == 401) {
                if (source() != sourceId) throw IOException("Section planning authorization changed")
                throw BooksHttpFailure(401)
            }
            result
        }
        if (response.status != 200) throw IOException("Section planning unavailable")
        val json = JSONObject(response.body)
        require(json.opt("schema") == "fitbaus.section-plan/v1" && json.opt("algorithm") == "sentence-pause-v1" &&
            json.opt("source_id") == sourceId && json.opt("item_id") == itemId && json.opt("audio_revision") == revision)
        fun cuts(key: String): List<Long> {
            val array = json.getJSONArray(key)
            require(array.length() == block.boundaries.size)
            return (0 until array.length()).map { i ->
                val value = array.get(i)
                require(value is Int || value is Long)
                (value as Number).toLong()
            }
        }
        require(cuts("nominal_boundaries_ms") == block.boundaries)
        val refined = cuts("boundaries_ms")
        require(block.accepts(refined))
        val reason = json.opt("reason")
        val digest = json.opt("transcript_digest")
        when (json.opt("state")) {
            "refined" -> require(refined != block.boundaries && reason == "sentence_or_pause" && digest is String && DIGEST.matches(digest))
            "nominal" -> {
                require(refined == block.boundaries)
                when (reason) {
                    "no_suitable_boundary" -> require(digest is String && DIGEST.matches(digest))
                    "missing_transcript", "no_movable_boundary" -> require(json.has("transcript_digest") && json.isNull("transcript_digest"))
                    else -> throw IOException("Unknown section plan reason")
                }
            }
            else -> throw IOException("Unknown section plan state")
        }
        return refined
    }

    private fun source(): String? {
        checkCancelled()
        val caps = transcriber.test(BooksHttp { url, token ->
            http.request(url, mapOf("Authorization" to "Bearer $token"), null)
        })
        checkCancelled()
        if (!caps.sectionPlanApi || caps.sourceUrl?.trimEnd('/') != books.address.trimEnd('/')) return null
        return caps.sourceId
    }

    private fun checkCancelled() {
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Section planning cancelled")
    }

    private companion object { val DIGEST = Regex("[0-9a-f]{64}") }
}
