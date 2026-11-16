// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPInputStream

internal class HttpUrlDownloader(
    private val connectTimeoutMs: Int = CONNECT_TIMEOUT_MS,
    private val readTimeoutMs: Int = READ_TIMEOUT_MS,
    private val maxBodyBytes: Int = MAX_BODY_BYTES,
) : Downloader() {
    override fun execute(request: Request): Response {
        val connection = URL(request.url()).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.instanceFollowRedirects = true
            connection.useCaches = false
            connection.requestMethod = request.httpMethod()
            connection.setRequestProperty("User-Agent", USER_AGENT)
            connection.setRequestProperty("Accept-Encoding", "gzip")
            for ((name, values) in request.headers()) {
                if (values.isEmpty()) continue
                connection.setRequestProperty(name, values.joinToString(","))
            }
            val body = request.dataToSend()
            if (body != null) {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val code = connection.responseCode
            if (code == 429) {
                throw ReCaptchaException("reCaptcha challenge requested", request.url())
            }
            val headers = LinkedHashMap<String, List<String>>()
            for ((name, values) in connection.headerFields) {
                if (name != null) headers[name] = values
            }
            val stream = if (code >= 400) connection.errorStream else connection.inputStream
            val text = stream?.let { readBody(it, connection.contentEncoding) } ?: ""
            return Response(code, connection.responseMessage, headers, text, connection.url.toString())
        } finally {
            connection.disconnect()
        }
    }

    private fun readBody(raw: InputStream, encoding: String?): String {
        val input = if (encoding.equals("gzip", ignoreCase = true)) GZIPInputStream(raw) else raw
        input.use {
            val out = ByteArrayOutputStream(16 * 1024)
            val buffer = ByteArray(16 * 1024)
            var total = 0
            while (true) {
                val read = it.read(buffer)
                if (read < 0) break
                total += read
                if (total > maxBodyBytes) throw IOException("response larger than $maxBodyBytes bytes")
                out.write(buffer, 0, read)
            }
            return out.toString("UTF-8")
        }
    }

    companion object {
        const val USER_AGENT: String = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0"
        const val CONNECT_TIMEOUT_MS: Int = 10_000
        const val READ_TIMEOUT_MS: Int = 20_000
        const val MAX_BODY_BYTES: Int = 8 * 1024 * 1024
    }
}
