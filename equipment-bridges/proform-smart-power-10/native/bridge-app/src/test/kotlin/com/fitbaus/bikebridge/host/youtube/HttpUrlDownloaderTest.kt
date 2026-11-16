// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.localization.Localization
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.zip.GZIPOutputStream

class HttpUrlDownloaderTest {
    private lateinit var server: LoopbackServer
    private val seen = ArrayList<String>()

    @BeforeEach
    fun startServer() {
        server = LoopbackServer { request ->
            when (request.path) {
                "/json" -> {
                    seen += "${request.method} ${request.headers["x-test"]} ${request.headers["user-agent"]} ${String(request.body)}"
                    val gz = ByteArrayOutputStream().also { out -> GZIPOutputStream(out).use { it.write("{\"ok\":true}".toByteArray()) } }.toByteArray()
                    LoopbackServer.Reply(200, gz, mapOf("Content-Encoding" to "gzip"))
                }
                "/limited" -> LoopbackServer.Reply(429, ByteArray(0))
                "/missing" -> LoopbackServer.Reply(404, "nope".toByteArray())
                "/huge" -> LoopbackServer.Reply(200, ByteArray(64 * 1024))
                else -> LoopbackServer.Reply(500, ByteArray(0))
            }
        }
    }

    @AfterEach
    fun stopServer() {
        server.close()
    }

    private fun url(path: String) = "http://127.0.0.1:${server.port}$path"

    @Test
    fun postsBodiesForwardsHeadersAndDecodesGzip() {
        val request = Request("POST", url("/json"), mapOf("X-Test" to listOf("yes")), "payload".toByteArray(), Localization.DEFAULT, false)
        val response = HttpUrlDownloader().execute(request)
        assertEquals(200, response.responseCode())
        assertEquals("{\"ok\":true}", response.responseBody())
        assertEquals(listOf("POST yes ${HttpUrlDownloader.USER_AGENT} payload"), seen)
    }

    @Test
    fun extractorUserAgentOverridesTheDefault() {
        val request = Request("GET", url("/json"), mapOf("User-Agent" to listOf("com.google.ios.youtube/20.03")), null, Localization.DEFAULT, false)
        HttpUrlDownloader().execute(request)
        assertTrue(seen.single().contains("com.google.ios.youtube/20.03"))
    }

    @Test
    fun tooManyRequestsIsReportedAsRateLimiting() {
        val request = Request("GET", url("/limited"), emptyMap(), null, Localization.DEFAULT, false)
        assertThrows(ReCaptchaException::class.java) { HttpUrlDownloader().execute(request) }
        assertEquals(FailureKind.RateLimited, runCatching { HttpUrlDownloader().execute(request) }.exceptionOrNull()?.let { NewPipeFailures.classify(it).kind })
    }

    @Test
    fun errorBodiesAreReturnedForTheExtractorToInterpret() {
        val response = HttpUrlDownloader().execute(Request("GET", url("/missing"), emptyMap(), null, Localization.DEFAULT, false))
        assertEquals(404, response.responseCode())
        assertEquals("nope", response.responseBody())
    }

    @Test
    fun responsesAreBounded() {
        val small = HttpUrlDownloader(maxBodyBytes = 16 * 1024)
        assertThrows(IOException::class.java) { small.execute(Request("GET", url("/huge"), emptyMap(), null, Localization.DEFAULT, false)) }
    }

    @Test
    fun playbackFailuresAreClassifiedForBoundedRecovery() {
        assertEquals(PlaybackFailure.Expired, PlaybackFailures.classify(2004, 403))
        assertEquals(PlaybackFailure.Expired, PlaybackFailures.classify(2004, 410))
        assertEquals(PlaybackFailure.Network, PlaybackFailures.classify(2004, 503))
        assertEquals(PlaybackFailure.Network, PlaybackFailures.classify(2001, null as Int?))
        assertEquals(PlaybackFailure.Unsupported, PlaybackFailures.classify(3001, null as Int?))
        assertEquals(PlaybackFailure.Decoder, PlaybackFailures.classify(4001, null as Int?))
        assertEquals(PlaybackFailure.Other, PlaybackFailures.classify(1000, null as Int?))
        assertEquals(null, PlaybackFailures.httpStatus(RuntimeException(IOException("reset"))))
    }
}

internal class LoopbackServer(private val handler: (Received) -> Reply) : AutoCloseable {
    class Received(val method: String, val path: String, val headers: Map<String, String>, val body: ByteArray)

    class Reply(val status: Int, val body: ByteArray, val headers: Map<String, String> = emptyMap())

    private val socket = ServerSocket(0, 8, InetAddress.getLoopbackAddress())
    private val thread = Thread {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: IOException) {
                break
            }
            client.use { serve(it) }
        }
    }.apply {
        isDaemon = true
        start()
    }

    val port: Int
        get() = socket.localPort

    private fun serve(client: Socket) {
        val input = BufferedInputStream(client.getInputStream())
        val requestLine = readLine(input)
        val headers = HashMap<String, String>()
        while (true) {
            val line = readLine(input)
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
        }
        val length = headers["content-length"]?.toIntOrNull() ?: 0
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(body, read, length - read)
            if (n < 0) break
            read += n
        }
        val parts = requestLine.split(" ")
        val reply = handler(Received(parts[0], parts[1], headers, body))
        val out = client.getOutputStream()
        val head = StringBuilder("HTTP/1.1 ${reply.status} X$CRLF" + "Content-Length: ${reply.body.size}$CRLF" + "Connection: close$CRLF")
        for ((name, value) in reply.headers) head.append(name).append(": ").append(value).append(CRLF)
        head.append(CRLF)
        out.write(head.toString().toByteArray())
        out.write(reply.body)
        out.flush()
    }

    private fun readLine(input: BufferedInputStream): String {
        val line = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0 || c == LF) break
            if (c != CR) line.append(c.toChar())
        }
        return line.toString()
    }

    override fun close() {
        socket.close()
        thread.join(1_000)
    }

    private companion object {
        const val CR = 13
        const val LF = 10
        val CRLF = String(charArrayOf(CR.toChar(), LF.toChar()))
    }
}
