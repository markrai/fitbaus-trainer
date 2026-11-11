// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BridgeHttpJsonTest {
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
    fun telemetryHasTrainerMetricShapesAndNoSoftwareControl() {
        val json = BridgeHttpJson.telemetry(snap)
        assertTrue(json.contains("\"connected\":true"))
        assertTrue(json.contains("\"rpm\":{\"value\":60"))
        assertTrue(json.contains("\"canSetResistance\":false"))
        assertTrue(json.contains("\"maxResistanceLevel\":22.0") || json.contains("\"maxResistanceLevel\":22"))
    }

    @Test
    fun statusDisablesResistanceControl() {
        val json = BridgeHttpJson.status(snap)
        assertTrue(json.contains("\"resistanceControlAvailable\":false"))
        assertTrue(json.contains("\"requested\":null"))
        assertTrue(json.contains("\"observed\":5"))
        assertTrue(json.contains("\"lastResistanceOutcome\":null"))
    }

    @Test
    fun statusIncludesSanitizedLastResistanceOutcome() {
        val json = BridgeHttpJson.status(
            snap.copy(lastResistanceOutcome = "level=3 rejected after transmit: security block"),
        )
        assertTrue(json.contains("\"lastResistanceOutcome\":\"level=3 rejected after transmit: security block\""))
        assertFalse(json.contains("serial"))
        assertFalse(json.contains("hash"))
    }

    @Test
    fun resistancePostIsUnavailable() {
        val result = BridgeHttpRouter.handle(
            "POST",
            "/api/v1/resistance",
            "{\"value\":8}",
            snap,
            pairingToken = TOKEN,
            presentedToken = TOKEN,
        )
        assertEquals(503, result.statusCode)
        assertTrue(result.body.contains("unavailable"))
    }

    @Test
    fun statusEnablesResistanceControlOnlyWhenMachineCanSet() {
        val ready = snap.copy(machine = snap.machine.copy(canSetResistance = true))
        val json = BridgeHttpJson.status(ready)
        assertTrue(json.contains("\"resistanceControlAvailable\":true"))
        val disconnected = ready.copy(connected = false)
        assertTrue(BridgeHttpJson.status(disconnected).contains("\"resistanceControlAvailable\":false"))
    }

    @Test
    fun resistancePostReturnsHandlerResultAfterRangeCheck() {
        var seen: Int? = null
        val accepted = BridgeHttpRouter.handle(
            "POST",
            "/api/v1/resistance",
            "{\"value\":8}",
            snap.copy(machine = snap.machine.copy(canSetResistance = true)),
            onResistance = {
                seen = it
                BridgeHttpResult(200, "OK", BridgeHttpJson.accepted(it))
            },
            pairingToken = TOKEN,
            presentedToken = TOKEN,
        )
        assertEquals(200, accepted.statusCode)
        assertEquals(8, seen)
        val outOfRange = BridgeHttpRouter.handle(
            "POST",
            "/api/v1/resistance",
            "{\"value\":16}",
            snap,
            onResistance = { BridgeHttpResult(200, "OK", BridgeHttpJson.accepted(it)) },
            pairingToken = TOKEN,
            presentedToken = TOKEN,
        )
        assertEquals(400, outOfRange.statusCode)
    }

    @Test
    fun getTelemetryOk() {
        val result = BridgeHttpRouter.handle("GET", "/api/v1/telemetry", "", snap)
        assertEquals(200, result.statusCode)
        assertTrue(result.body.contains("\"watts\":{\"value\":100"))
    }

    @Test
    fun readRoutesDoNotRequirePairing() {
        for (route in listOf("/health", "/api/v1/health", "/api/v1/status", "/api/v1/telemetry", "/api/v1/status/")) {
            val result = BridgeHttpRouter.handle("GET", route, "", snap, pairingToken = TOKEN)
            assertEquals(200, result.statusCode, route)
        }
    }

    @Test
    fun heartRateIngestDoesNotTouchBike() {
        var seen: Int? = null
        val result = BridgeHttpRouter.handle(
            "POST",
            "/api/v1/heartrate",
            "{\"value\":140}",
            snap,
            onHeartRate = { seen = it },
            pairingToken = TOKEN,
            presentedToken = TOKEN,
        )
        assertEquals(200, result.statusCode)
        assertEquals(140, seen)
    }

    @Test
    fun heartRateWithoutSinkIsNotImplemented() {
        val result = BridgeHttpRouter.handle(
            "POST",
            "/api/v1/heartrate",
            "{\"value\":140}",
            snap,
            pairingToken = TOKEN,
            presentedToken = TOKEN,
        )
        assertEquals(501, result.statusCode)
        assertTrue(result.body.contains("not supported"))
    }

    @Test
    fun brightnessWithSinkAccepted() {
        var seen: Int? = null
        val result = BridgeHttpRouter.handle(
            "POST",
            "/api/v1/brightness",
            "{\"value\":40}",
            snap,
            onBrightness = { seen = it },
            pairingToken = TOKEN,
            presentedToken = TOKEN,
        )
        assertEquals(200, result.statusCode)
        assertEquals(40, seen)
    }

    @Test
    fun everyControlRouteFailsClosedWithoutMatchingToken() {
        var invoked = 0
        val routes = listOf("/api/v1/resistance", "/api/v1/heartrate", "/api/v1/brightness")
        val presentations = listOf(null, "", "0".repeat(32), TOKEN.dropLast(1), "not-a-token")
        for (route in routes) {
            for (presented in presentations) {
                val result = BridgeHttpRouter.handle(
                    "POST",
                    route,
                    "{\"value\":5}",
                    snap.copy(machine = snap.machine.copy(canSetResistance = true)),
                    onHeartRate = { invoked += 1 },
                    onBrightness = { invoked += 1 },
                    onResistance = {
                        invoked += 1
                        BridgeHttpResult(200, "OK", BridgeHttpJson.accepted(it))
                    },
                    pairingToken = TOKEN,
                    presentedToken = presented,
                )
                assertEquals(401, result.statusCode, "$route $presented")
                assertTrue(result.body.contains("pairing required"))
            }
            val unconfigured = BridgeHttpRouter.handle(
                "POST",
                route,
                "{\"value\":5}",
                snap,
                onHeartRate = { invoked += 1 },
                onBrightness = { invoked += 1 },
                onResistance = {
                    invoked += 1
                    BridgeHttpResult(200, "OK", BridgeHttpJson.accepted(it))
                },
                pairingToken = null,
                presentedToken = TOKEN,
            )
            assertEquals(401, unconfigured.statusCode, route)
        }
        assertEquals(0, invoked)
    }

    @Test
    fun spacedDashedAndLowercaseTokenPresentationsAreAccepted() {
        for (presented in listOf("XB5G5132", "XB5G 5132", "XB5G-5132", "xb5g 5132", " xb5g-5132 ", PairingToken.grouped(TOKEN))) {
            val result = BridgeHttpRouter.handle(
                "POST",
                "/api/v1/brightness",
                "{\"value\":40}",
                snap,
                onBrightness = {},
                pairingToken = TOKEN,
                presentedToken = presented,
            )
            assertEquals(200, result.statusCode, presented)
        }
    }

    @Test
    fun preflightAllowsPairingHeader() {
        val result = BridgeHttpRouter.handle("OPTIONS", "/api/v1/resistance", "", snap, pairingToken = TOKEN)
        assertEquals(204, result.statusCode)
        assertEquals("", result.body)
        assertEquals("GET, POST, OPTIONS", result.headers["Access-Control-Allow-Methods"])
        assertTrue(result.headers["Access-Control-Allow-Headers"]!!.contains("X-Fitbaus-Token"))
        assertTrue(result.headers["Access-Control-Allow-Headers"]!!.contains("Content-Type"))
        assertEquals("600", result.headers["Access-Control-Max-Age"])
    }

    @Test
    fun resistanceWindowAndMalformedBodiesDoNotInvokeHandler() {
        val seen = ArrayList<Int>()
        val ready = snap.copy(machine = snap.machine.copy(canSetResistance = true))
        fun postResistance(body: String) = BridgeHttpRouter.handle(
            "POST",
            "/api/v1/resistance",
            body,
            ready,
            onResistance = {
                seen += it
                BridgeHttpResult(200, "OK", BridgeHttpJson.accepted(it))
            },
            pairingToken = TOKEN,
            presentedToken = TOKEN,
        )
        fun postHeartRate(body: String) = BridgeHttpRouter.handle(
            "POST",
            "/api/v1/heartrate",
            body,
            snap,
            onHeartRate = { seen += it },
            pairingToken = TOKEN,
            presentedToken = TOKEN,
        )
        assertEquals(400, postResistance("not-json").statusCode)
        assertEquals(400, postResistance("{}").statusCode)
        assertEquals(400, postResistance("{\"value\":0}").statusCode)
        assertEquals(400, postResistance("{\"value\":16}").statusCode)
        assertEquals(400, postHeartRate("{\"value\":29}").statusCode)
        assertEquals(400, postHeartRate("{\"value\":251}").statusCode)
        assertEquals(200, postResistance("{\"value\":1}").statusCode)
        assertEquals(200, postResistance("{\"value\":15}").statusCode)
        assertEquals(listOf(1, 15), seen)
        assertEquals(404, BridgeHttpRouter.handle("GET", "/api/v1/resistance", "", snap).statusCode)
    }

    @Test
    fun legacyResistanceRouteIsNotAnAlias() {
        var invoked = false
        val result = BridgeHttpRouter.handle(
            "POST",
            "/resistance",
            "{\"value\":5}",
            snap,
            onResistance = {
                invoked = true
                BridgeHttpResult(200, "OK", BridgeHttpJson.accepted(it))
            },
            pairingToken = TOKEN,
            presentedToken = TOKEN,
        )
        assertEquals(404, result.statusCode)
        assertTrue(result.body.contains("use POST /api/v1/resistance"))
        assertFalse(invoked)
    }

    private companion object {
        const val TOKEN = "XB5G5132"
    }
}

class PairingTokenTest {
    @Test
    fun generatedTokensAreWellFormedAndDistinct() {
        val seen = HashSet<String>()
        repeat(200) {
            val token = PairingToken.generate()
            assertTrue(PairingToken.isWellFormed(token), token)
            assertEquals(8, token.length)
            assertTrue(token.all { it in PairingToken.GENERATED_ALPHABET }, token)
            assertTrue(seen.add(token))
        }
    }

    @Test
    fun generatedAlphabetOmitsLookAlikeCharacters() {
        for (ch in "01OIL") assertFalse(ch in PairingToken.GENERATED_ALPHABET, ch.toString())
    }

    @Test
    fun normalizeAcceptsSpacesDashesAndAnyCase() {
        assertEquals("XB5G5132", PairingToken.normalize("XB5G 5132"))
        assertEquals("XB5G5132", PairingToken.normalize("XB5G5132"))
        assertEquals("XB5G5132", PairingToken.normalize("XB5G-5132"))
        assertEquals("XB5G5132", PairingToken.normalize("xb5g-5132"))
        assertEquals("XB5G5132", PairingToken.normalize(" x b 5 g - 5 1 3 2 "))
    }

    @Test
    fun normalizeRejectsWrongLengthAndSymbols() {
        for (bad in listOf("XB5G513", "XB5G51322", "XB5G_5132", "XB5G.5132", "XB5G513!", "0123456789abcdef0123456789abcdef", "")) {
            assertEquals(null, PairingToken.normalize(bad), bad)
        }
    }

    @Test
    fun matchingIgnoresPresentationButNotCharacters() {
        assertTrue(PairingToken.matches("XB5G5132", "xb5g-5132"))
        assertFalse(PairingToken.matches("XB5G5132", "XB5G5133"))
    }

    @Test
    fun malformedExpectedTokenNeverMatches() {
        assertFalse(PairingToken.matches("short", "short"))
        assertFalse(PairingToken.matches(null, null))
        assertFalse(PairingToken.matches("", ""))
    }
}

class ContinuousReadPlanTest {
    @Test
    fun wattsAndRpmOnEveryCycle() {
        for (cycle in 0..15) {
            val fields = ContinuousReadPlan.fieldsForCycle(cycle)
            assertTrue(fields.contains(BikeField.WATTS), "cycle $cycle missing watts")
            assertTrue(fields.contains(BikeField.RPM), "cycle $cycle missing rpm")
        }
    }

    @Test
    fun resistanceLessFrequentThanWatts() {
        val cycles = (0 until 8).map { ContinuousReadPlan.fieldsForCycle(it) }
        val withR = cycles.count { it.contains(BikeField.RESISTANCE) }
        val with18 = cycles.count { it.contains(BikeField.ACTUAL_RESISTANCE) }
        assertEquals(1, withR)
        assertEquals(1, with18)
        assertFalse(cycles[3].contains(BikeField.ACTUAL_RESISTANCE))
        assertTrue(cycles[3].contains(BikeField.RESISTANCE))
        assertTrue(cycles[7].contains(BikeField.ACTUAL_RESISTANCE))
    }

    @Test
    fun spacingIsARequestBoundNotAMeasuredRate() {
        assertEquals(100L, ContinuousReadPlan.CYCLE_SPACING_MS)
        assertTrue(ContinuousReadPlan.CYCLE_SPACING_MS < 1000L)
    }

    @Test
    fun missingRequestedMetricIsNotCurrentAndKeepsObservedAt() {
        val previous = sampleSnapshot()
        val next = ContinuousReadPlan.applyReadings(
            previous = previous,
            readings = mapOf(
                BikeField.RPM to FieldValue.Number(61L),
                BikeField.WATTS to FieldValue.Number(101L),
            ),
            nowIso = "T1",
            maxResistanceLevel = 22,
            identity = BridgeMachineJson(maxResistanceLevel = 22.0),
            requested = listOf(BikeField.WATTS, BikeField.RPM, BikeField.RESISTANCE),
        )
        assertTrue(next.rpm.current)
        assertTrue(next.watts.current)
        assertEquals("T1", next.rpm.observedAt)
        assertFalse(next.resistance.current)
        assertEquals("T-r", next.resistance.observedAt)
        assertEquals(2, next.resistance.value)
        assertEquals("T1", next.snapshotAt)
        assertTrue(next.actualResistance.current)
        assertEquals("T-a", next.actualResistance.observedAt)
    }

    @Test
    fun unsuccessfulReadDoesNotRefreshSnapshotAt() {
        val previous = sampleSnapshot()
        val next = ContinuousReadPlan.afterUnsuccessfulRead(previous, connected = false)
        assertEquals("T0", next.snapshotAt)
        assertEquals("T-w", next.watts.observedAt)
        assertEquals(100, next.watts.value)
        assertFalse(next.watts.current)
        assertFalse(next.rpm.current)
        assertFalse(next.resistance.current)
        assertFalse(next.connected)
        assertTrue(next.initialized)
    }

    @Test
    fun freshWattsAndRpmRequiresBothNumericValues() {
        val watts = FieldValue.Number(100L)
        val rpm = FieldValue.Number(60L)
        assertTrue(ContinuousReadPlan.hasFreshWattsAndRpm(mapOf(BikeField.WATTS to watts, BikeField.RPM to rpm)))
        assertFalse(ContinuousReadPlan.hasFreshWattsAndRpm(emptyMap()))
        assertFalse(ContinuousReadPlan.hasFreshWattsAndRpm(mapOf(BikeField.WATTS to watts)))
        assertFalse(ContinuousReadPlan.hasFreshWattsAndRpm(mapOf(BikeField.RPM to rpm)))
        assertFalse(
            ContinuousReadPlan.hasFreshWattsAndRpm(
                mapOf(BikeField.WATTS to FieldValue.Sentinel, BikeField.RPM to rpm),
            ),
        )
        assertFalse(
            ContinuousReadPlan.hasFreshWattsAndRpm(
                mapOf(BikeField.WATTS to watts, BikeField.RPM to FieldValue.Sentinel),
            ),
        )
    }

    private fun sampleSnapshot() = NativeTelemetrySnapshot(
        connected = true,
        initialized = true,
        snapshotAt = "T0",
        resistance = BridgeMetricJson(2, "T-r", true),
        rpm = BridgeMetricJson(60, "T-rpm", true),
        watts = BridgeMetricJson(100, "T-w", true),
        actualResistance = BridgeMetricJson(5, "T-a", true),
        machine = BridgeMachineJson(maxResistanceLevel = 22.0),
    )
}
