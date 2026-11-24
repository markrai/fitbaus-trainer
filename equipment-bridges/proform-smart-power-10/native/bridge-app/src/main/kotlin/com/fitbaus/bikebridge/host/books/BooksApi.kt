// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.Proxy
import java.net.URLEncoder

internal class BooksServer(address: String) {
    private val origin: String
    val isCleartext: Boolean

    init {
        val uri = URI(address.trim())
        requireTransport(uri)
        require(uri.rawQuery == null)
        isCleartext = uri.scheme.equals("http", ignoreCase = true)
        val path = uri.rawPath.orEmpty().trimEnd('/')
        require(path.isEmpty() || path == "/audiobookshelf")
        origin = (if (isCleartext) "http://" else "https://") + uri.rawAuthority + path
    }

    fun playUrl(itemId: String): String = "$origin/api/items/${id(itemId)}/play"

    fun sessionUrl(sessionId: String, close: Boolean): String = "$origin/api/session/${id(sessionId)}/${if (close) "close" else "sync"}"

    fun audioUrl(itemId: String, path: String): String {
        val prefix = "/api/items/${id(itemId)}/file/"
        require(path.startsWith(prefix))
        return origin + prefix + id(path.removePrefix(prefix))
    }

    fun loginUrl(): String = "$origin/login"

    fun refreshUrl(): String = "$origin/auth/refresh"

    fun librariesUrl(): String = "$origin/api/libraries"

    fun itemsUrl(libraryId: String, page: Int): String {
        require(page >= 0)
        return "$origin/api/libraries/${id(libraryId)}/items?limit=$PAGE_SIZE&page=$page&sort=media.metadata.title&minified=1"
    }

    fun searchUrl(libraryId: String, query: String): String {
        val value = query.trim()
        require(value.length in 1..200)
        return "$origin/api/libraries/${id(libraryId)}/search?limit=20&q=${URLEncoder.encode(value, "UTF-8")}"
    }

    fun coverUrl(itemId: String): String = "$origin/api/items/${id(itemId)}/cover?width=256"

    private fun id(value: String): String {
        require(value.matches(Regex("[A-Za-z0-9_-]{1,128}")))
        return value
    }

    companion object {
        const val PAGE_SIZE = 40

        fun address(protocol: String, host: String, port: String, subpath: Boolean): String {
            require(protocol == "http" || protocol == "https")
            val name = host.trim()
            require(name.isNotEmpty() && name.none { it.isWhitespace() || it in "/:@?#\\\\[]" })
            val number = port.trim()
            require(number.isEmpty() || (number.all { it in '0'..'9' } && (number.toIntOrNull() ?: 0) in 1..65535))
            val value = "$protocol://$name" + (if (number.isEmpty()) "" else ":$number") +
                (if (subpath) "/audiobookshelf" else "")
            BooksServer(value)
            return value
        }

        fun requireTransport(uri: URI) {
            val host = uri.host ?: throw IllegalArgumentException("Invalid server host")
            require(uri.rawUserInfo == null && uri.rawFragment == null)
            require(uri.port == -1 || uri.port in 1..65535)
            require(uri.scheme.equals("https", ignoreCase = true) ||
                (uri.scheme.equals("http", ignoreCase = true) && isPrivateIpv4(host)))
        }

        private fun isPrivateIpv4(host: String): Boolean {
            val parts = host.split('.')
            if (parts.size != 4) return false
            val octets = parts.map { part ->
                val value = part.toIntOrNull() ?: return false
                if (value !in 0..255 || part != value.toString()) return false
                value
            }
            return octets[0] == 10 ||
                (octets[0] == 172 && octets[1] in 16..31) ||
                (octets[0] == 192 && octets[1] == 168)
        }

        fun openConnection(url: String): HttpURLConnection {
            val uri = URI(url)
            requireTransport(uri)
            val connection = if (uri.scheme.equals("http", ignoreCase = true)) {
                uri.toURL().openConnection(Proxy.NO_PROXY)
            } else {
                uri.toURL().openConnection()
            }
            return (connection as HttpURLConnection).apply { instanceFollowRedirects = false }
        }
    }
}

internal data class BooksLibrary(val id: String, val name: String)

internal data class BooksItem(
    val id: String,
    val title: String,
    val author: String,
    val durationSeconds: Double,
    val audioTrackCount: Int?,
)

internal data class BooksPage(val items: List<BooksItem>, val nextPage: Int?)

internal data class BooksHttpResponse(val status: Int, val body: String)

internal fun interface BooksHttp {
    fun get(url: String, token: String): BooksHttpResponse
}

internal fun interface BooksAuthHttp {
    fun post(url: String, headers: Map<String, String>, body: String): BooksHttpResponse
}

internal class BooksUrlConnectionHttp : BooksHttp, BooksAuthHttp {
    override fun get(url: String, token: String): BooksHttpResponse =
        request(url, "GET", mapOf("Authorization" to "Bearer $token"), null)

    override fun post(url: String, headers: Map<String, String>, body: String): BooksHttpResponse =
        request(url, "POST", headers, body.toByteArray(Charsets.UTF_8))

    private fun request(url: String, method: String, headers: Map<String, String>, body: ByteArray?): BooksHttpResponse {
        val connection = BooksServer.openConnection(url)
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.requestMethod = method
            connection.setRequestProperty("Accept", "application/json")
            for ((name, value) in headers) connection.setRequestProperty(name, value)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            if (status !in 200..299) return BooksHttpResponse(status, "")
            val output = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Request cancelled")
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > MAX_RESPONSE_BYTES) {
                        throw IOException("Audiobookshelf response exceeds limit")
                    }
                    output.write(buffer, 0, count)
                }
            }
            return BooksHttpResponse(status, output.toString("UTF-8"))
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 2 * 1024 * 1024
    }
}

internal class BooksHttpFailure(val status: Int) : IOException("Audiobookshelf HTTP $status")

internal class BooksApi(
    private val server: BooksServer,
    private val session: BooksSession,
    private val http: BooksHttp = BooksUrlConnectionHttp(),
) {
    constructor(server: BooksServer, token: String, http: BooksHttp = BooksUrlConnectionHttp()) :
        this(server, BooksSession(BooksCredentials(token), BooksAuth(server)), http)

    fun libraries(): List<BooksLibrary> {
        val rows = get(server.librariesUrl()).getJSONArray("libraries")
        return (0 until rows.length()).mapNotNull { index ->
            val row = rows.getJSONObject(index)
            if (row.optString("mediaType") != "book") return@mapNotNull null
            val id = row.getString("id")
            server.itemsUrl(id, 0)
            BooksLibrary(id, row.getString("name").take(160))
        }
    }

    fun items(libraryId: String, page: Int = 0): BooksPage {
        val json = get(server.itemsUrl(libraryId, page))
        val rows = json.getJSONArray("results")
        val items = (0 until rows.length()).mapNotNull { parseItem(rows.getJSONObject(it)) }
        val consumed = page.toLong() * BooksServer.PAGE_SIZE + rows.length()
        val total = json.optLong("total", -1)
        val hasMore = rows.length() > 0 && if (total >= 0) consumed < total else rows.length() >= BooksServer.PAGE_SIZE
        return BooksPage(items, if (hasMore && page < Int.MAX_VALUE) page + 1 else null)
    }

    fun search(libraryId: String, query: String): List<BooksItem> {
        val rows = get(server.searchUrl(libraryId, query)).getJSONArray("book")
        return (0 until minOf(rows.length(), 20)).mapNotNull { index ->
            rows.optJSONObject(index)?.optJSONObject("libraryItem")?.let { parseItem(it) }
        }.distinctBy { it.id }
    }

    private fun parseItem(row: JSONObject): BooksItem? {
        if (row.optBoolean("isMissing") || row.optBoolean("isInvalid")) return null
        val media = row.optJSONObject("media") ?: return null
        val metadata = media.optJSONObject("metadata") ?: return null
        val title = metadata.optString("title").take(300)
        if (title.isBlank()) return null
        val id = row.getString("id")
        server.coverUrl(id)
        val tracks = media.optInt("numTracks", media.optInt("numAudioTracks", -1)).takeIf { it >= 0 }
        if (tracks == 0) return null
        return BooksItem(
            id,
            title,
            metadata.optString("authorName").take(200),
            media.optDouble("duration", 0.0).takeIf { it.isFinite() && it >= 0 } ?: 0.0,
            tracks,
        )
    }

    private fun get(url: String): JSONObject {
        return session.authorized { token ->
            val response = http.get(url, token)
            if (response.status !in 200..299) throw BooksHttpFailure(response.status)
            JSONObject(response.body)
        }
    }
}
