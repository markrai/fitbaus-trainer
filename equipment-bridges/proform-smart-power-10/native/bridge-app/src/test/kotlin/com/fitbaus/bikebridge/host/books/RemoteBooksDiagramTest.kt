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
import java.io.File
import java.io.IOException

class RemoteBooksDiagramTest {
    private val revision = "a".repeat(64)
    private val digest = "b".repeat(64)
    private val paired = TranscriberConnection("http://192.168.1.193:8765", "c".repeat(43))
    private val books = BooksConnection("http://192.168.1.193:13378", "source-token")
    private val session = BooksPlaybackSession("session", listOf(
        BooksAudioTrack(books.address + "/api/items/book/file/123", 0, 600_000)
    ), emptyList(), 0)
    private val selection = BooksSummarySelection("book", session, BooksSection(0, 300_000, null, 1, 2), revision)
    private val summary = BooksSummaryState.Ready(revision, " A summary. ", "test-model", "section-v1", digest, true, "home")
    private val identity = BooksDiagramIdentity(selection, summary)
    private val capabilities = JSONObject("""{"api_version":1,"transcript_schema":"fitbaus.transcript/v1","job_api":true,"source_configured":true,"source_id":"home","transcription":true,"engine_ready":true,"max_window_ms":300000,"summary_api":true,"summary_diagram_api":true,"summary_diagram_formats":["flowchart"],"summary_provider":{"configured":true,"protocol":"openai-chat/v1","model":"test-model"}}""")
        .put("source_url", books.address)

    private fun response(state: String) = identity.body().put("schema", "fitbaus.section-diagram/v1")
        .put("diagram_prompt_version", "flowchart-v1").put("parser_version", "flowchart-subset-v1")
        .put("state", state)

    private fun ready(): JSONObject = response("ready").put("cache_hit", false)
        .put("mermaid", "flowchart TD\nA[\"Concept\"]\nB[\"Result\"]\nA --> B")
        .put("graph", JSONObject("""{"direction":"TD","nodes":[{"id":"A","label":"Concept"},{"id":"B","label":"Result"}],"edges":[{"from":"A","to":"B"}]}"""))

    private fun client(caps: JSONObject = capabilities, pause: (Long) -> Unit = {},
                       clock: () -> Long = { 0L }, request: (JSONObject) -> BooksHttpResponse): RemoteBooksDiagram =
        RemoteBooksDiagram(paired, books, TranscriberHttp { url, headers, body ->
            assertEquals("Bearer ${paired.token}", headers["Authorization"])
            if (url.endsWith("/v1/capabilities")) {
                assertNull(headers["X-Audiobookshelf-Token"])
                BooksHttpResponse(200, caps.toString())
            } else {
                assertEquals(paired.address + "/v1/section-diagrams", url)
                assertEquals("source-token", headers["X-Audiobookshelf-Token"])
                val value = JSONObject(requireNotNull(body))
                assertEquals(identity.body().keys().asSequence().toSet(), value.keys().asSequence().toSet())
                for (key in identity.body().keys()) assertEquals(identity.body().get(key).toString(), value.get(key).toString())
                request(value)
            }
        }, pause, clock)

    @Test
    fun readyAfterDeferredUsesExactSummaryDigestAndNoRawText() {
        var requests = 0
        val pauses = mutableListOf<Long>()
        val graph = client(pause = { pauses.add(it) }) {
            requests++
            if (requests == 1) BooksHttpResponse(202, response("deferred").put("retry_after_seconds", 3).toString())
            else BooksHttpResponse(200, ready().toString())
        }.load(identity)
        assertEquals(2, requests)
        assertEquals(listOf(3000L), pauses)
        assertEquals("TD", graph.direction)
        assertEquals(listOf(BooksDiagramEdge("A", "B", null)), graph.edges)
        assertEquals(64, identity.summaryDigest.length)
        assertFalse(identity.body().has("summary"))
        assertFalse(identity.body().has("prompt"))
        assertFalse(identity.summaryDigest == BooksDiagramIdentity(selection, summary.copy(summary = summary.summary.trim())).summaryDigest)
    }

    @Test
    fun legacyCapabilityOrWrongSourceNeverReceivesSourceToken() {
        for (caps in listOf(JSONObject(capabilities.toString()).apply { remove("summary_diagram_api") },
            JSONObject(capabilities.toString()).put("summary_diagram_formats", JSONArray().put("sequence")),
            JSONObject(capabilities.toString()).put("source_url", "http://192.168.1.10:13378"))) {
            assertThrows(IllegalArgumentException::class.java) {
                client(caps) { error("Unexpected diagram request") }.load(identity)
            }
        }
    }

    @Test
    fun deferredIsBoundedAndInvalidResultsNeverRetry() {
        var requests = 0
        assertThrows(IOException::class.java) {
            client {
                requests++
                BooksHttpResponse(202, response("deferred").put("retry_after_seconds", 3).toString())
            }.load(identity)
        }
        assertEquals(4, requests)
        requests = 0
        assertThrows(IllegalArgumentException::class.java) {
            client {
                requests++
                BooksHttpResponse(200, ready().put("summary_digest", "d".repeat(64)).toString())
            }.load(identity)
        }
        assertEquals(1, requests)
    }

    @Test
    fun rejectsGraphCyclesDanglingEdgesDuplicatesAndUnsafeLabels() {
        for (change in listOf<(JSONObject) -> Unit>(
            { it.getJSONArray("edges").put(JSONObject().put("from", "B").put("to", "A")) },
            { it.getJSONArray("edges").put(JSONObject().put("from", "A").put("to", "Z")) },
            { it.getJSONArray("edges").put(JSONObject().put("from", "A").put("to", "B")) },
            { it.getJSONArray("nodes").getJSONObject(0).put("label", "<script>") },
            { it.getJSONArray("nodes").getJSONObject(0).put("label", "a\u202eb") },
            { it.getJSONArray("nodes").getJSONObject(0).put("label", "a".repeat(65)) },
            { it.getJSONArray("nodes").put(JSONObject().put("id", "C").put("label", "Disconnected")) }
        )) {
            val result = ready()
            change(result.getJSONObject("graph"))
            assertThrows(IllegalArgumentException::class.java) { BooksDiagramValidation.parse(result) }
        }
    }

    @Test
    fun scopeRejectsDuplicateAttemptsAndLateCompletions() {
        val scope = BooksDiagramScope()
        val ticket = requireNotNull(scope.begin(identity))
        assertNull(scope.begin(BooksDiagramIdentity(selection.copy(), summary)))
        assertTrue(scope.show())
        scope.hide()
        assertFalse(scope.open)
        val graph = BooksDiagramValidation.parse(ready())
        assertTrue(scope.complete(ticket, BooksDiagramState.Ready(graph)))
        assertTrue(scope.show())
        assertEquals(BooksDiagramState.Ready(graph), scope.state)
        scope.clear()
        assertFalse(scope.complete(ticket, BooksDiagramState.Ready(graph)))
        assertFalse(scope.show())
        val replacement = BooksPlaybackSession(session.id, session.tracks, session.chapters, session.resumeMs)
        val next = requireNotNull(scope.begin(BooksDiagramIdentity(selection.copy(session = replacement), summary)))
        assertFalse(scope.matches(selection, summary))
        assertFalse(scope.complete(ticket, BooksDiagramState.Ready(graph)))
        assertTrue(scope.complete(next, BooksDiagramState.Unavailable))
    }

    @Test
    fun expiredBudgetAndProviderFailuresDoNotTriggerFurtherDiagramRequests() {
        var now = 0L
        var calls = 0
        assertThrows(IOException::class.java) {
            client(clock = { now }, pause = { now += 180_000_000_000L }) {
                calls++
                BooksHttpResponse(202, response("deferred").put("retry_after_seconds", 3).toString())
            }.load(identity)
        }
        assertEquals(1, calls)
        for (status in listOf(401, 403, 409, 429, 502, 503, 504)) {
            calls = 0
            assertThrows(IOException::class.java) {
                client {
                    calls++
                    BooksHttpResponse(status, "")
                }.load(identity)
            }
            assertEquals(1, calls)
        }
    }

    @Test
    fun cachedGraphStillRequiresExactIdentityAndValidStructure() {
        val cached = ready().put("cache_hit", true)
        val graph = client { BooksHttpResponse(200, cached.toString()) }.load(identity)
        assertEquals("Concept", graph.nodes.first().label)
        for (field in listOf("source_id", "item_id", "audio_revision", "transcript_digest",
            "summary_model", "summary_prompt_version", "summary_digest", "diagram_prompt_version", "parser_version")) {
            val bad = JSONObject(cached.toString()).put(field, "incorrect")
            assertThrows(IllegalArgumentException::class.java) {
                client { BooksHttpResponse(200, bad.toString()) }.load(identity)
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            client { BooksHttpResponse(200, JSONObject(cached.toString()).put("end_ms", 300001).toString()) }.load(identity)
        }
        val oversized = JSONObject(cached.toString()).put("mermaid", "x".repeat(8193))
        assertThrows(IllegalArgumentException::class.java) {
            client { BooksHttpResponse(200, oversized.toString()) }.load(identity)
        }
    }

    @Test
    fun changedSectionOrSummaryCannotReuseTheCurrentGraph() {
        val scope = BooksDiagramScope()
        val ticket = requireNotNull(scope.begin(identity))
        val graph = BooksDiagramValidation.parse(ready())
        assertTrue(scope.complete(ticket, BooksDiagramState.Ready(graph)))
        assertTrue(scope.show())
        assertFalse(scope.matches(selection.copy(section = BooksSection(300_000, 600_000, null, 2, 2)), summary))
        assertFalse(scope.matches(selection, summary.copy(summary = "Replacement")))
        assertFalse(scope.matches(selection.copy(expectedRevision = "d".repeat(64)), summary))
        scope.clear()
        assertFalse(scope.open)
        assertNull(scope.state)
        assertFalse(scope.complete(ticket, BooksDiagramState.Ready(graph)))
    }

    @Test
    fun drawGateConsumesOnlyVisibleCurrentSummaryOnce() {
        val gate = BooksSummaryDrawGate()
        var deliveries = 0
        assertNull(gate.begin(false))
        val hidden = requireNotNull(gate.begin(true))
        gate.finish(hidden, false) { deliveries++; true }
        assertEquals(0, deliveries)
        val stale = requireNotNull(gate.begin(true))
        gate.changed()
        gate.finish(stale, true) { deliveries++; true }
        assertEquals(0, deliveries)
        val declined = requireNotNull(gate.begin(true))
        gate.finish(declined, true) { false }
        val ready = requireNotNull(gate.begin(true))
        assertNull(gate.begin(true))
        gate.finish(ready, true) { deliveries++; true }
        repeat(1000) {
            assertNull(gate.begin(true))
            assertNull(gate.begin(false))
        }
        assertEquals(1, deliveries)
        gate.changed()
        val cancelled = requireNotNull(gate.begin(true))
        gate.cancel(cancelled)
        val replacement = requireNotNull(gate.begin(true))
        gate.finish(cancelled, true) { deliveries++; true }
        assertEquals(1, deliveries)
        gate.finish(replacement, true) { deliveries++; true }
        assertEquals(2, deliveries)
    }

    @Test
    fun visibleDrawAndFullscreenOwnershipAreExplicit() {
        val root = "src/main/kotlin/com/fitbaus/bikebridge/host/"
        val viewport = File(root + "books/BooksNarrationViewport.kt").readText()
        val readAlong = File(root + "books/BooksReadAlong.kt").readText()
        val content = File(root + "books/BooksContent.kt").readText()
        assertTrue(viewport.contains("super.dispatchDraw(canvas)"))
        assertTrue(viewport.contains("drawGate.finish(ticket, summaryIsVisible() && longPressAction != null)"))
        assertTrue(readAlong.contains("narrationViewport.onSummaryDrawn = ::prefetchVisibleDiagram"))
        assertTrue(readAlong.contains("if (diagramScope.ticket !== ticket) return@post"))
        assertTrue(readAlong.contains("summarySelection(livePosition())"))
        assertTrue(readAlong.contains("diagramScope.matches(liveSelection, diagramSummary(liveSelection))"))
        assertTrue(content.contains("hud.visibility = if (diagram) GONE else VISIBLE"))
        assertTrue(content.contains("presentationMode != BooksPresentationMode.DIAGRAM"))
    }
}
