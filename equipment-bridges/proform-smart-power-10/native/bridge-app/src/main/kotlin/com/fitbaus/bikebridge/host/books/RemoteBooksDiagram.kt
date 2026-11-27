// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.security.MessageDigest
import java.util.Locale

internal data class BooksDiagramNode(val id: String, val label: String)
internal data class BooksDiagramEdge(val from: String, val to: String, val label: String?)
internal data class BooksDiagramGraph(val direction: String, val nodes: List<BooksDiagramNode>, val edges: List<BooksDiagramEdge>)

internal class BooksDiagramIdentity(
    val selection: BooksSummarySelection,
    val summary: BooksSummaryState.Ready,
) {
    val sourceId = requireNotNull(summary.sourceId)
    val summaryDigest = MessageDigest.getInstance("SHA-256").digest(summary.summary.toByteArray(Charsets.UTF_8))
        .joinToString("") { String.format(Locale.US, "%02x", it.toInt() and 255) }

    init {
        require(BooksIdentifier.isValid(sourceId))
        require(selection.expectedRevision == null || selection.expectedRevision == summary.revision)
        require(summary.promptVersion == "section-v1")
    }

    fun matches(current: BooksSummarySelection?, ready: BooksSummaryState.Ready?): Boolean =
        current != null && selection.session === current.session && selection.itemId == current.itemId &&
            selection.section == current.section && current.expectedRevision == summary.revision && summary === ready

    fun body(): JSONObject = JSONObject().put("source_id", sourceId).put("item_id", selection.itemId)
        .put("audio_revision", summary.revision).put("start_ms", selection.section.startMs)
        .put("end_ms", selection.section.endMs).put("transcript_digest", summary.transcriptDigest)
        .put("summary_model", summary.model).put("summary_prompt_version", summary.promptVersion)
        .put("summary_digest", summaryDigest)

    fun validate(result: JSONObject, concepts: Boolean = false) {
        if (concepts) {
            require(result.opt("schema") == "fitbaus.section-concepts/v1" &&
                result.opt("concept_prompt_version") in setOf("concepts-v1", "concepts-v2") && result.opt("concept_input_version") == "plain-lines-v1")
        } else {
            require(result.opt("schema") == "fitbaus.section-diagram/v1" &&
                result.opt("diagram_prompt_version") == "flowchart-v1" && result.opt("parser_version") == "flowchart-subset-v1")
        }
        val expected = body()
        for (key in expected.keys()) {
            val value = result.get(key)
            val wanted = expected.get(key)
            if (wanted is Number) {
                require((value is Int || value is Long) && (value as Number).toLong() == wanted.toLong())
            } else require(value == wanted)
        }
    }
}

internal object BooksDiagramValidation {
    private val idPattern = Regex("[A-Z][A-Z0-9]{0,7}")
    private val entityPattern = Regex("&(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);")

    fun parse(result: JSONObject): BooksDiagramGraph {
        val source = result.opt("mermaid") as? String ?: error("Invalid diagram source")
        require(source.isNotBlank() && source.toByteArray(Charsets.UTF_8).size <= 8192 && result.opt("cache_hit") is Boolean)
        val graph = result.getJSONObject("graph")
        require(graph.keys().asSequence().toSet() == setOf("direction", "nodes", "edges"))
        val direction = graph.opt("direction") as? String ?: error("Invalid direction")
        require(direction in setOf("TD", "LR"))
        val nodes = graph.getJSONArray("nodes")
        val edges = graph.getJSONArray("edges")
        require(nodes.length() in 2..10 && edges.length() in 1..16)
        val parsedNodes = (0 until nodes.length()).map { index ->
            val node = nodes.getJSONObject(index)
            require(node.keys().asSequence().toSet() == setOf("id", "label"))
            val id = node.opt("id") as? String ?: error("Invalid node")
            require(idPattern.matches(id))
            BooksDiagramNode(id, label(node.opt("label"), 64))
        }
        val ids = parsedNodes.map { it.id }.toSet()
        require(ids.size == parsedNodes.size)
        val parsedEdges = (0 until edges.length()).map { index ->
            val edge = edges.getJSONObject(index)
            val keys = edge.keys().asSequence().toSet()
            require(keys == setOf("from", "to") || keys == setOf("from", "to", "label"))
            val from = edge.opt("from") as? String ?: error("Invalid edge")
            val to = edge.opt("to") as? String ?: error("Invalid edge")
            require(from in ids && to in ids && from != to)
            BooksDiagramEdge(from, to, if (edge.has("label")) label(edge.opt("label"), 24) else null)
        }
        require(parsedEdges.map { it.from to it.to }.distinct().size == parsedEdges.size)
        val remaining = ids.toMutableSet()
        while (remaining.isNotEmpty()) {
            val roots = remaining.filter { node -> parsedEdges.none { it.to == node && it.from in remaining } }
            require(roots.isNotEmpty())
            remaining.removeAll(roots.toSet())
        }
        val connected = mutableSetOf(parsedNodes.first().id)
        repeat(ids.size) {
            for (edge in parsedEdges) {
                if (edge.from in connected || edge.to in connected) {
                    connected.add(edge.from)
                    connected.add(edge.to)
                }
            }
        }
        require(connected == ids)
        return BooksDiagramGraph(direction, parsedNodes, parsedEdges)
    }

    private fun label(raw: Any?, limit: Int): String {
        val value = raw as? String ?: error("Invalid label")
        require(value == value.trim() && value.codePointCount(0, value.length) in 1..limit &&
            !entityPattern.containsMatchIn(value))
        var offset = 0
        while (offset < value.length) {
            val cp = value.codePointAt(offset)
            val type = Character.getType(cp)
            require(type !in setOf(Character.CONTROL.toInt(), Character.FORMAT.toInt(), Character.SURROGATE.toInt(),
                Character.PRIVATE_USE.toInt(), Character.UNASSIGNED.toInt(), Character.LINE_SEPARATOR.toInt(),
                Character.PARAGRAPH_SEPARATOR.toInt()) && cp !in listOf(60, 62, 34, 92, 124, 91, 93))
            offset += Character.charCount(cp)
        }
        return value
    }
}

internal class RemoteBooksDiagram(
    private val transcriber: TranscriberConnection,
    private val books: BooksConnection,
    private val http: TranscriberHttp = TranscriberHttp { url, headers, body ->
        val client = BooksUrlConnectionHttp(readTimeoutMs = 150_000, maxResponseBytes = 32 * 1024)
        if (body == null) client.getWithHeaders(url, headers) else client.post(url, headers, body)
    },
    private val pause: (Long) -> Unit = { Thread.sleep(it) },
    private val clock: () -> Long = System::nanoTime,
) {
    init {
        require(books.server.isCleartext || !transcriber.address.startsWith("http://", ignoreCase = true))
    }

    fun load(identity: BooksDiagramIdentity): BooksDiagramGraph =
        BooksDiagramValidation.parse(fetch(identity, preferConcepts = false).second)

    fun loadVisualization(identity: BooksDiagramIdentity): BooksDiagramState {
        val (concepts, result) = fetch(identity, preferConcepts = true)
        return if (concepts) BooksDiagramState.Concepts(BooksConceptValidation.parse(result))
        else BooksDiagramState.Ready(BooksDiagramValidation.parse(result))
    }

    fun loadElaboration(identity: BooksDiagramIdentity, index: Int, concept: String): String {
        require(index in 0 until BooksConceptValidation.MAX_CONCEPTS)
        val result = fetch(identity, preferConcepts = true, elaboration = index to concept).second
        val explanation = result.opt("explanation") as? String ?: error("Invalid elaboration")
        require(explanation.isNotBlank() && explanation.length <= 16_000)
        return explanation
    }

    private fun fetch(identity: BooksDiagramIdentity, preferConcepts: Boolean,
                      elaboration: Pair<Int, String>? = null): Pair<Boolean, JSONObject> {
        val deadline = clock() + 180_000_000_000L
        fun check() {
            if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Diagram cancelled")
            if (clock() - deadline >= 0) throw IOException("Diagram deadline exceeded")
        }
        check()
        val caps = transcriber.test(BooksHttp { url, token -> http.request(url, mapOf("Authorization" to "Bearer $token"), null) })
        val concepts = preferConcepts && caps.summaryConceptApi
        require((concepts || caps.summaryDiagramApi) && caps.summaryProvider?.model == identity.summary.model &&
            caps.sourceId == identity.sourceId && caps.sourceUrl?.trimEnd('/') == books.address.trimEnd('/'))
        if (elaboration != null) require(concepts && caps.conceptElaborationApi)
        val endpoint = when {
            elaboration != null -> "/v1/concept-elaboration"
            concepts -> "/v1/section-concepts"
            else -> "/v1/section-diagrams"
        }
        val payload = if (elaboration == null) identity.body().toString() else JSONObject()
            .put("parent", identity.body()).put("index", elaboration.first).put("concept", elaboration.second).toString()
        repeat(4) { attempt ->
            check()
            val response = books.session.authorized { token ->
                check()
                val result = http.request(transcriber.address + endpoint,
                    mapOf("Authorization" to "Bearer ${transcriber.token}", "X-Audiobookshelf-Token" to token), payload)
                check()
                result
            }
            check()
            if (response.status !in setOf(200, 202)) throw IOException("Diagram unavailable")
            require(response.body.toByteArray(Charsets.UTF_8).size <= 32 * 1024)
            val result = JSONObject(response.body)
            identity.validate(result, concepts)
            if (elaboration != null) {
                require(result.opt("index") == elaboration.first && result.opt("concept") == elaboration.second)
            }
            if (response.status == 200) {
                require(result.opt("state") == "ready")
                return concepts to result
            }
            require(result.opt("state") == "deferred" && !result.has("graph") && !result.has("mermaid") && !result.has("concepts") && !result.has("explanation"))
            val rawSeconds = result.opt("retry_after_seconds")
            require(rawSeconds is Int || rawSeconds is Long)
            val seconds = (rawSeconds as Number).toLong()
            require(seconds in 1L..10L)
            if (attempt == 3) throw IOException("Diagram admission unavailable")
            pause(seconds * 1000L)
        }
        throw IOException("Diagram unavailable")
    }
}
