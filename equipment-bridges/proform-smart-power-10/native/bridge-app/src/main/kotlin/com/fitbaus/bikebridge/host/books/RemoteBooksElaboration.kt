package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.net.HttpURLConnection

internal class BooksElaborationEvents(
    private val identity: BooksDiagramIdentity,
    private val index: Int,
    private val concept: String,
) {
    private val content = StringBuilder()
    private var started = false

    fun validateIdentity(value: JSONObject) {
        identity.validate(value, concepts = true)
        require(value.opt("index") == index && value.opt("concept") == concept)
    }

    fun accept(value: JSONObject, onPartial: (String) -> Unit): String? {
        when (value.opt("state")) {
            "streaming" -> {
                require(!started)
                validateIdentity(value)
                started = true
            }
            "delta" -> {
                require(started)
                val delta = value.opt("text") as? String ?: error("Invalid explanation delta")
                require(delta.isNotEmpty() && content.length + delta.length <= 16_000)
                content.append(delta)
                onPartial(content.toString())
            }
            "ready" -> {
                require(started)
                validateIdentity(value)
                val result = value.opt("explanation") as? String ?: error("Invalid explanation")
                require(result.isNotBlank() && result == content.toString().trim())
                return result
            }
            else -> throw IOException("Explanation stream unavailable")
        }
        return null
    }
}

internal class RemoteBooksElaboration(
    private val transcriber: TranscriberConnection,
    private val books: BooksConnection,
    private val openConnection: (String) -> HttpURLConnection = { BooksServer.openConnection(it) },
) {
    init {
        require(books.server.isCleartext || !transcriber.address.startsWith("http://", ignoreCase = true))
    }

    fun load(identity: BooksDiagramIdentity, index: Int, concept: String, onPartial: (String) -> Unit): String {
        require(index in 0 until BooksConceptValidation.MAX_CONCEPTS)
        val caps = transcriber.test()
        require(caps.conceptElaborationApi && caps.summaryConceptApi &&
            caps.summaryProvider?.model == identity.summary.model && caps.sourceId == identity.sourceId &&
            caps.sourceUrl?.trimEnd('/') == books.address.trimEnd('/'))
        if (!caps.conceptElaborationStreamApi) {
            return RemoteBooksDiagram(transcriber, books).loadElaboration(identity, index, concept)
        }
        val payload = JSONObject().put("parent", identity.body()).put("index", index)
            .put("concept", concept).toString().toByteArray(Charsets.UTF_8)
        val deadline = System.nanoTime() + 180_000_000_000L
        fun check() {
            if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Explanation cancelled")
            if (System.nanoTime() - deadline >= 0) throw IOException("Explanation deadline exceeded")
        }
        repeat(4) { attempt ->
            check()
            var deferred = 0L
            val result = books.session.authorized { token ->
                check()
                val connection = openConnection(transcriber.address + "/v1/concept-elaboration/stream")
                try {
                    connection.instanceFollowRedirects = false
                    connection.connectTimeout = 10_000
                    connection.readTimeout = 150_000
                    connection.requestMethod = "POST"
                    connection.setRequestProperty("Accept", "application/x-ndjson, application/json")
                    connection.setRequestProperty("Accept-Encoding", "identity")
                    connection.setRequestProperty("Authorization", "Bearer ${transcriber.token}")
                    connection.setRequestProperty("X-Audiobookshelf-Token", token)
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(payload.size)
                    connection.outputStream.use { it.write(payload) }
                    val status = connection.responseCode
                    if (status !in setOf(200, 202)) throw IOException("Explanation unavailable")
                    val contentType = connection.contentType?.substringBefore(';')?.trim()
                    val events = BooksElaborationEvents(identity, index, concept)
                    BufferedInputStream(connection.inputStream).use { input ->
                        val reader = BoundedElaborationReader(input, ::check)
                        if (status == 202) {
                            require(contentType == "application/json")
                            val value = JSONObject(reader.line() ?: error("Missing admission response"))
                            events.validateIdentity(value)
                            require(value.opt("state") == "deferred" && !value.has("explanation"))
                            val raw = value.opt("retry_after_seconds")
                            require(raw is Int || raw is Long)
                            deferred = (raw as Number).toLong()
                            require(deferred in 1L..10L)
                            null
                        } else {
                            require(contentType == "application/x-ndjson")
                            var completed: String? = null
                            while (completed == null) {
                                val line = reader.line() ?: throw IOException("Incomplete explanation")
                                completed = events.accept(JSONObject(line), onPartial)
                            }
                            completed
                        }
                    }
                } finally {
                    connection.disconnect()
                }
            }
            if (result != null) return result
            if (attempt == 3) throw IOException("Explanation admission unavailable")
            Thread.sleep(deferred * 1000L)
        }
        throw IOException("Explanation unavailable")
    }
}

internal class BoundedElaborationReader(private val input: InputStream, private val check: () -> Unit) {
    private var total = 0

    fun line(): String? {
        val output = ByteArrayOutputStream()
        while (true) {
            check()
            val byte = input.read()
            if (byte < 0) return if (output.size() == 0) null else output.toString("UTF-8")
            total++
            if (total > 256 * 1024 || output.size() > 32 * 1024) throw IOException("Explanation stream exceeds limit")
            if (byte == 10) return output.toString("UTF-8").trimEnd('\r')
            output.write(byte)
        }
    }
}
