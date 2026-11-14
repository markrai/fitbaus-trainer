// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import com.fitbaus.bikebridge.protocol.BridgeHttpJson
import com.fitbaus.bikebridge.protocol.BridgeHttpResult
import com.fitbaus.bikebridge.protocol.BridgeMachineJson
import com.fitbaus.bikebridge.protocol.BridgeMetricJson
import com.fitbaus.bikebridge.protocol.NativeTelemetrySnapshot
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList

class NativeHttpServerTest {
    private val snap = NativeTelemetrySnapshot(
        connected = true,
        initialized = true,
        snapshotAt = "2026-11-08T19:00:00.000Z",
        resistance = BridgeMetricJson(5, "2026-11-08T19:00:00.000Z", true),
        rpm = BridgeMetricJson(60, "2026-11-08T19:00:00.000Z", true),
        watts = BridgeMetricJson(100, "2026-11-08T19:00:00.000Z", true),
        machine = BridgeMachineJson(canSetResistance = false, maxResistanceLevel = 22.0),
    )

    @Test
    fun telemetryPreservesTrainerShapeWithoutPairing() {
        withServer { port ->
            val response = exchange(port, "GET /api/v1/telemetry HTTP/1.1\r\nHost: localhost\r\n\r\n")
            assertTrue(response.contains("HTTP/1.1 200"))
            assertTrue(response.contains("\"rpm\":{\"value\":60"))
            assertTrue(response.contains("\"canSetResistance\":false"))
            assertTrue(response.contains("Access-Control-Allow-Origin: *"))
        }
    }

    @Test
    fun statusAndHealthDoNotRequirePairing() {
        withServer { port ->
            assertTrue(exchange(port, "GET /api/v1/status HTTP/1.1\r\nHost: localhost\r\n\r\n").contains("HTTP/1.1 200"))
            assertTrue(exchange(port, "GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n").contains("HTTP/1.1 200"))
        }
    }

    @Test
    fun resistanceWithoutHandlerStaysUnavailableWhenPaired() {
        withServer { port ->
            val response = exchange(port, post("/api/v1/resistance", "{\"value\":8}", TOKEN))
            assertTrue(response.contains("HTTP/1.1 503"), response)
            assertTrue(response.contains("unavailable"))
        }
    }

    @Test
    fun resistanceHandlerResultIsReturnedWhenPaired() {
        val seen = CopyOnWriteArrayList<Int>()
        withServer(onResistance = {
            seen += it
            BridgeHttpResult(200, "OK", BridgeHttpJson.accepted(it))
        }) { port ->
            val response = exchange(port, post("/api/v1/resistance", "{\"value\":8}", TOKEN))
            assertTrue(response.contains("HTTP/1.1 200"), response)
            assertTrue(response.contains("\"requested\":8"), response)
        }
        assertEquals(listOf(8), seen)
    }

    @Test
    fun everyPostFailsClosedWithoutToken() {
        val seen = CopyOnWriteArrayList<String>()
        withServer(
            onResistance = {
                seen += "resistance"
                BridgeHttpResult(200, "OK", BridgeHttpJson.accepted(it))
            },
            onHeartRate = { seen += "hr" },
            onBrightness = { seen += "brightness" },
        ) { port ->
            for (route in listOf("/api/v1/resistance", "/api/v1/heartrate", "/api/v1/brightness")) {
                val missing = exchange(port, post(route, "{\"value\":50}", null))
                assertTrue(missing.contains("HTTP/1.1 401"), missing)
                val wrong = exchange(port, post(route, "{\"value\":50}", "ZZZZ9999"))
                assertTrue(wrong.contains("HTTP/1.1 401"), wrong)
            }
        }
        assertTrue(seen.isEmpty(), seen.toString())
    }

    @Test
    fun heartRateAndBrightnessReachSinksWhenPaired() {
        val heartRate = HeartRateStore()
        val brightness = BrightnessStore()
        withServer(
            onHeartRate = { heartRate.record(it) },
            onBrightness = { brightness.record(it) },
        ) { port ->
            val hr = exchange(port, post("/api/v1/heartrate", "{\"value\":140}", TOKEN))
            assertTrue(hr.contains("HTTP/1.1 200"), hr)
            assertTrue(hr.contains("\"requested\":140"), hr)
            val level = exchange(port, post("/api/v1/brightness", "{\"value\":35}", TOKEN))
            assertTrue(level.contains("HTTP/1.1 200"), level)
            val outOfRange = exchange(port, post("/api/v1/brightness", "{\"value\":101}", TOKEN))
            assertTrue(outOfRange.contains("HTTP/1.1 400"), outOfRange)
        }
        assertEquals(140, heartRate.displayBpm())
        assertEquals(35, brightness.percent())
    }

    @Test
    fun pairingHeaderNameIsCaseInsensitive() {
        val brightness = BrightnessStore()
        withServer(onBrightness = { brightness.record(it) }) { port ->
            val response = exchange(
                port,
                "POST /api/v1/brightness HTTP/1.1\r\nHost: localhost\r\nx-fitbaus-token: $TOKEN\r\n" +
                    "Content-Length: 12\r\n\r\n{\"value\":60}",
            )
            assertTrue(response.contains("HTTP/1.1 200"), response)
        }
        assertEquals(60, brightness.percent())
    }

    @Test
    fun preflightReturnsCorsHeadersWithEmptyBody() {
        withServer { port ->
            val response = exchange(
                port,
                "OPTIONS /api/v1/resistance HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:5173\r\n" +
                    "Access-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type,x-fitbaus-token\r\n\r\n",
            )
            assertTrue(response.startsWith("HTTP/1.1 204"), response)
            assertTrue(response.contains("Access-Control-Allow-Origin: *"), response)
            assertTrue(response.contains("Access-Control-Allow-Methods: GET, POST, OPTIONS"), response)
            assertTrue(response.contains("Access-Control-Allow-Headers: Content-Type, X-Fitbaus-Token"), response)
            assertTrue(response.contains("Access-Control-Max-Age: 600"), response)
            assertTrue(response.contains("Content-Length: 0"), response)
            assertTrue(response.endsWith("\r\n\r\n"), response)
        }
    }

    @Test
    fun oversizedBodyIsRejected() {
        withServer { port ->
            val len = BridgeHttpJson.MAX_REQUEST_BODY_BYTES + 1
            val header = "POST /api/v1/heartrate HTTP/1.1\r\nHost: localhost\r\nContent-Length: $len\r\n\r\n"
            val body = "x".repeat(64)
            val response = exchange(port, header + body)
            assertTrue(response.contains("HTTP/1.1 413"))
            assertTrue(response.contains("too large"))
        }
    }

    @Test
    fun extraConnectionsAreBounded() {
        val server = NativeHttpServer(
            bindAddress = "127.0.0.1",
            port = 0,
            snapshot = {
                Thread.sleep(400)
                snap
            },
        )
        server.start()
        val port = server.boundPort()
        try {
            val holders = (1..BridgeHttpJson.MAX_CONCURRENT_CONNECTIONS).map {
                Socket("127.0.0.1", port).also { it.soTimeout = 2000 }
            }
            Thread.sleep(50)
            val overflow = exchange(
                port,
                "GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
            holders.forEach { it.close() }
            assertTrue(
                overflow.contains("HTTP/1.1 503") || overflow.contains("too many connections"),
                overflow,
            )
        } finally {
            server.stop()
        }
    }

    @Test
    fun bindFailureIsReportedAndRecoversWhenPortFrees() {
        val blocker = NativeHttpServer(bindAddress = "127.0.0.1", port = 0, snapshot = { snap })
        var server: NativeHttpServer? = null
        try {
            blocker.start()
            val port = blocker.boundPort()
            assertTrue(port > 0)
            server = NativeHttpServer(bindAddress = "127.0.0.1", port = port, snapshot = { snap })
            var failed = false
            try {
                server.start()
            } catch (_: Exception) {
                failed = true
            }
            assertTrue(failed)
            assertFalse(server.isListening())
            assertTrue(server.lastError() != null)
            blocker.stop()
            server.start()
            assertTrue(server.isListening())
            assertTrue(server.lastError() == null)
            assertTrue(exchange(port, "GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n").contains("HTTP/1.1 200"))
        } finally {
            try {
                server?.stop()
            } catch (_: Exception) {
            }
            try {
                blocker.stop()
            } catch (_: Exception) {
            }
        }
    }

    @Test
    fun repeatedStopStartOnSamePortRemainsExclusive() {
        val first = NativeHttpServer(bindAddress = "127.0.0.1", port = 0, snapshot = { snap })
        var owner: NativeHttpServer? = null
        var challenger: NativeHttpServer? = null
        try {
            first.start()
            val port = first.boundPort()
            assertTrue(port > 0)
            first.stop()
            owner = NativeHttpServer(bindAddress = "127.0.0.1", port = port, snapshot = { snap })
            challenger = NativeHttpServer(bindAddress = "127.0.0.1", port = port, snapshot = { snap })
            owner.start()
            assertTrue(owner.isListening())
            var failed = false
            try {
                challenger.start()
            } catch (_: Exception) {
                failed = true
            }
            assertTrue(failed)
            assertFalse(challenger.isListening())
            assertTrue(challenger.lastError() != null)
            owner.stop()
            challenger.start()
            assertTrue(challenger.isListening())
            assertTrue(exchange(port, "GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n").contains("HTTP/1.1 200"))
        } finally {
            try {
                challenger?.stop()
            } catch (_: Exception) {
            }
            try {
                owner?.stop()
            } catch (_: Exception) {
            }
            try {
                first.stop()
            } catch (_: Exception) {
            }
        }
    }

    private fun withServer(
        onResistance: ((Int) -> BridgeHttpResult)? = null,
        onHeartRate: ((Int) -> Unit)? = null,
        onBrightness: ((Int) -> Unit)? = null,
        block: (Int) -> Unit,
    ) {
        val server = NativeHttpServer(
            bindAddress = "127.0.0.1",
            port = 0,
            snapshot = { snap },
            onHeartRate = onHeartRate,
            onBrightness = onBrightness,
            onResistance = onResistance,
            pairingToken = { TOKEN },
        )
        server.start()
        try {
            assertTrue(server.boundPort() > 0)
            block(server.boundPort())
        } finally {
            server.stop()
        }
    }

    private fun post(route: String, body: String, token: String?): String {
        val tokenHeader = if (token == null) "" else "X-Fitbaus-Token: $token\r\n"
        return "POST $route HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n$tokenHeader" +
            "Content-Length: ${body.length}\r\n\r\n$body"
    }

    private fun exchange(port: Int, request: String): String {
        Socket("127.0.0.1", port).use { socket ->
            socket.soTimeout = 2000
            socket.getOutputStream().write(request.toByteArray(StandardCharsets.US_ASCII))
            socket.getOutputStream().flush()
            return String(socket.getInputStream().readBytes(), StandardCharsets.UTF_8)
        }
    }

    private companion object {
        const val TOKEN = "XB5G5132"
    }
}
