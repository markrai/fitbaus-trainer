// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import com.fitbaus.bikebridge.protocol.BridgeHttpJson
import com.fitbaus.bikebridge.protocol.BridgeHttpResult
import com.fitbaus.bikebridge.protocol.BridgeHttpRouter
import com.fitbaus.bikebridge.protocol.NativeTelemetrySnapshot
import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.Charset
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal class NativeHttpServer(
    private val bindAddress: String = BridgeHttpJson.DEFAULT_BIND,
    private val port: Int = BridgeHttpJson.DEFAULT_PORT,
    private val snapshot: () -> NativeTelemetrySnapshot,
    private val onHeartRate: ((Int) -> Unit)? = null,
    private val onBrightness: ((Int) -> Unit)? = null,
    private val onResistance: ((Int) -> BridgeHttpResult)? = null,
    private val pairingToken: () -> String? = { null },
) {
    private val running = AtomicBoolean(false)
    private val lastError = AtomicReference<String?>(null)
    private val inflight = Semaphore(BridgeHttpJson.MAX_CONCURRENT_CONNECTIONS)
    @Volatile
    private var server: ServerSocket? = null
    private var thread: Thread? = null

    fun lastError(): String? = lastError.get()
    fun boundPort(): Int = server?.localPort ?: -1
    fun isListening(): Boolean = running.get() && server != null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        var socket: ServerSocket? = null
        try {
            socket = ServerSocket()
            socket.reuseAddress = true
            socket.bind(
                InetSocketAddress(InetAddress.getByName(bindAddress), port),
                BridgeHttpJson.ACCEPT_BACKLOG,
            )
            lastError.set(null)
            val listening = socket
            val worker = Thread({
                while (running.get()) {
                    try {
                        val client = listening.accept()
                        if (!inflight.tryAcquire()) {
                            try {
                                writeHttp(
                                    client.getOutputStream(),
                                    BridgeHttpResult(
                                        503,
                                        "Service Unavailable",
                                        BridgeHttpJson.error("too many connections"),
                                    ),
                                )
                            } catch (_: Exception) {
                            } finally {
                                try {
                                    client.close()
                                } catch (_: Exception) {
                                }
                            }
                            continue
                        }
                        Thread {
                            try {
                                handleClient(client)
                            } finally {
                                inflight.release()
                            }
                        }.start()
                    } catch (_: Exception) {
                        if (running.get()) {
                            lastError.set("accept failed")
                        }
                    }
                }
            }, "fitbaus-native-http")
            worker.isDaemon = true
            server = listening
            thread = worker
            worker.start()
            socket = null
        } catch (ex: Exception) {
            running.set(false)
            server = null
            thread = null
            lastError.set(ex.message)
            try {
                socket?.close()
            } catch (_: Exception) {
            }
            throw ex
        }
    }

    fun stop() {
        running.set(false)
        try {
            server?.close()
        } catch (_: Exception) {
        }
        server = null
        thread = null
    }

    private fun handleClient(socket: Socket) {
        socket.soTimeout = BridgeHttpJson.SOCKET_TIMEOUT_MS
        try {
            val input = BufferedInputStream(socket.getInputStream())
            when (val parsed = readHttpRequest(input)) {
                is ReadOutcome.Reject -> writeHttp(socket.getOutputStream(), parsed.result)
                is ReadOutcome.Ok -> {
                    val request = parsed.request
                    val result = BridgeHttpRouter.handle(
                        method = request.method,
                        path = request.path,
                        body = request.body,
                        snapshot = snapshot(),
                        onHeartRate = onHeartRate,
                        onBrightness = onBrightness,
                        onResistance = onResistance,
                        pairingToken = pairingToken(),
                        presentedToken = request.token,
                    )
                    writeHttp(socket.getOutputStream(), result)
                }
            }
        } catch (_: Exception) {
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {
            }
        }
    }

    private data class ParsedRequest(val method: String, val path: String, val body: String, val token: String?)

    private sealed class ReadOutcome {
        data class Ok(val request: ParsedRequest) : ReadOutcome()
        data class Reject(val result: BridgeHttpResult) : ReadOutcome()
    }

    private fun readHttpRequest(input: BufferedInputStream): ReadOutcome {
        val header = StringBuilder()
        var total = 0
        while (total < BridgeHttpJson.MAX_HEADER_BYTES) {
            val n = input.read()
            if (n < 0) break
            header.append(n.toChar())
            total += 1
            if (header.endsWith("\r\n\r\n")) break
        }
        val text = header.toString()
        val lines = text.split("\r\n")
        if (lines.isEmpty()) {
            return ReadOutcome.Reject(BridgeHttpResult(400, "Bad Request", BridgeHttpJson.error("malformed request")))
        }
        val parts = lines[0].split(' ')
        if (parts.size < 2) {
            return ReadOutcome.Reject(BridgeHttpResult(400, "Bad Request", BridgeHttpJson.error("malformed request")))
        }
        val method = parts[0]
        val path = parts[1]
        var contentLength = 0
        var token: String? = null
        val tokenPrefix = BridgeHttpRouter.PAIRING_HEADER.lowercase() + ":"
        for (line in lines) {
            val lowered = line.lowercase()
            if (lowered.startsWith("content-length:")) {
                contentLength = line.substringAfter(':').trim().toIntOrNull() ?: -1
            } else if (lowered.startsWith(tokenPrefix)) {
                token = line.substringAfter(':').trim()
            }
        }
        if (contentLength < 0) {
            return ReadOutcome.Reject(BridgeHttpResult(400, "Bad Request", BridgeHttpJson.error("malformed request")))
        }
        if (contentLength > BridgeHttpJson.MAX_REQUEST_BODY_BYTES) {
            return ReadOutcome.Reject(
                BridgeHttpResult(413, "Payload Too Large", BridgeHttpJson.error("request body too large")),
            )
        }
        val body = if (contentLength > 0) {
            val buf = ByteArray(contentLength)
            var got = 0
            while (got < contentLength) {
                val n = input.read(buf, got, contentLength - got)
                if (n < 0) break
                got += n
            }
            String(buf, 0, got, Charset.forName("UTF-8"))
        } else {
            ""
        }
        return ReadOutcome.Ok(ParsedRequest(method, path, body, token))
    }

    private fun writeHttp(out: OutputStream, result: BridgeHttpResult) {
        val bytes = result.body.toByteArray(Charset.forName("UTF-8"))
        val header = StringBuilder()
        header.append("HTTP/1.1 ").append(result.statusCode).append(' ').append(result.reason).append("\r\n")
        header.append("Content-Type: ").append(result.contentType).append("\r\n")
        header.append("Content-Length: ").append(bytes.size).append("\r\n")
        header.append("Connection: close\r\n")
        header.append("Access-Control-Allow-Origin: *\r\n")
        for ((name, value) in result.headers) {
            header.append(name).append(": ").append(value).append("\r\n")
        }
        header.append("\r\n")
        out.write(header.toString().toByteArray(Charset.forName("US-ASCII")))
        out.write(bytes)
        out.flush()
    }
}
