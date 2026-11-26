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
    fun visibleDrawAndFullscreenOwnershipAreExplicit() {
        val root = "src/main/kotlin/com/fitbaus/bikebridge/host/"
        val viewport = File(root + "books/BooksNarrationViewport.kt").readText()
        val readAlong = File(root + "books/BooksReadAlong.kt").readText()
        val content = File(root + "books/BooksContent.kt").readText()
        assertTrue(viewport.contains("super.dispatchDraw(canvas)"))
        assertTrue(viewport.contains("if (drawnGeneration == summaryGeneration && summaryIsVisible()) onSummaryDrawn?.invoke()"))
        assertTrue(readAlong.contains("narrationViewport.onSummaryDrawn = ::prefetchVisibleDiagram"))
        assertTrue(readAlong.contains("if (diagramScope.ticket !== ticket) return@post"))
        assertTrue(content.contains("hud.visibility = if (diagram) GONE else VISIBLE"))
        assertTrue(content.contains("presentationMode != BooksPresentationMode.DIAGRAM"))
    }
}
