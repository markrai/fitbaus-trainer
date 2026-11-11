// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.policy.DiagnosticBudget
import com.fitbaus.bikebridge.equipmentprobe.session.ExtendedObservationSequence
import com.fitbaus.bikebridge.equipmentprobe.session.StopKind
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.atomic.AtomicLong

class ExtendedObservationTest {
    private val wattsRpm = hex("02 09 02 02 96 00 48 00 ED")
    private val resistance = response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(5))
    private val actual = response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(5))
    private val missingData = hex("02 05 02 02 0B")

    @Test
    fun usesSeparateBudgetAndStopsWhenExhausted() {
        val responses = ArrayList<TransportResult>()
        repeat(40) {
            responses += TransportResult.Ok(wattsRpm)
            responses += TransportResult.Ok(resistance)
            responses += TransportResult.Ok(actual)
        }
        val transport = ScriptedTransport(responses).withConfirmedPrimary()
        val clock = AtomicLong(0L)
        val outcome = ExtendedObservationSequence(
            transport = transport,
            budget = DiagnosticBudget(5),
            durationMs = 60_000L,
            requestSpacingMs = 0L,
            monoElapsedMs = { clock.getAndAdd(1) },
            sleeper = {},
        ).run()
        assertEquals(StopKind.BUDGET_EXHAUSTED, outcome.stopKind)
        assertTrue(outcome.requestsUsed <= 5)
    }

    @Test
    fun securityBlockStopsExtendedLoopWithNoFurtherRequests() {
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(hex("02 05 02 08 11")),
                TransportResult.Ok(wattsRpm),
            ),
        ).withConfirmedPrimary()
        val outcome = ExtendedObservationSequence(
            transport = transport,
            durationMs = 60_000L,
            requestSpacingMs = 0L,
            monoElapsedMs = { 0L },
            sleeper = {},
        ).run()
        assertEquals(StopKind.SECURITY_BLOCK, outcome.stopKind)
        assertEquals(1, transport.sent.size)
    }

    @Test
    fun twoConsecutiveFailuresIncludingActualResistanceStopWithoutFurtherRequests() {
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(wattsRpm),
                TransportResult.Ok(resistance),
                TransportResult.Ok(missingData),
                TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE),
                TransportResult.Ok(wattsRpm),
            ),
        ).withConfirmedPrimary()
        val outcome = ExtendedObservationSequence(
            transport = transport,
            durationMs = 60_000L,
            requestSpacingMs = 0L,
            monoElapsedMs = { 0L },
            sleeper = {},
        ).run()
        assertEquals(StopKind.TRANSPORT_FAILURE, outcome.stopKind)
        assertEquals(4, transport.sent.size)
        assertTrue(outcome.summary.contains("terminal failure"))
    }

    @Test
    fun successfulWattsRpmBetweenActualResistanceFailuresResetsGlobalCounter() {
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(wattsRpm),
                TransportResult.Ok(resistance),
                TransportResult.Ok(missingData),
                TransportResult.Ok(wattsRpm),
                TransportResult.Ok(resistance),
                TransportResult.Ok(missingData),
                TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE),
                TransportResult.Ok(actual),
            ),
        ).withConfirmedPrimary()
        val outcome = ExtendedObservationSequence(
            transport = transport,
            durationMs = 60_000L,
            requestSpacingMs = 0L,
            monoElapsedMs = { 0L },
            sleeper = {},
        ).run()
        assertEquals(StopKind.TRANSPORT_FAILURE, outcome.stopKind)
        assertEquals(7, transport.sent.size)
    }

    @Test
    fun hardFailOnActualResistanceIsTerminal() {
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(wattsRpm),
                TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE),
                TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE),
                TransportResult.Ok(wattsRpm),
            ),
        ).withConfirmedPrimary()
        val outcome = ExtendedObservationSequence(
            transport = transport,
            durationMs = 60_000L,
            requestSpacingMs = 0L,
            monoElapsedMs = { 0L },
            sleeper = {},
        ).run()
        assertEquals(StopKind.TRANSPORT_FAILURE, outcome.stopKind)
        assertEquals(3, transport.sent.size)
        assertTrue(outcome.summary.contains("ACTUAL_RESISTANCE"))
    }

    @Test
    fun deadlineExpiryDuringSpacingWaitPreventsAdditionalTransmission() {
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(wattsRpm),
                TransportResult.Ok(resistance),
                TransportResult.Ok(actual),
            ),
        ).withConfirmedPrimary()
        val clock = AtomicLong(0L)
        val outcome = ExtendedObservationSequence(
            transport = transport,
            durationMs = 1_000L,
            requestSpacingMs = 500L,
            monoElapsedMs = { clock.get() },
            sleeper = { clock.set(2_000L) },
        ).run()
        assertEquals(1, transport.sent.size)
        assertEquals(StopKind.NONE, outcome.stopKind)
        assertTrue(outcome.summary.contains("duration elapsed"))
    }

    @Test
    fun cadenceBudgetIsInternallyConsistentAtMostTwoRequestsPerSecond() {
        assertEquals(500L, ProbeConstants.EXTENDED_REQUEST_SPACING_MS)
        assertEquals(120, ProbeConstants.EXTENDED_REQUEST_BUDGET)
        assertEquals(60_000L, ProbeConstants.EXTENDED_DURATION_MS)
        assertTrue(ProbeConstants.EXTENDED_REQUEST_BUDGET <= ProbeConstants.EXTENDED_DURATION_MS / ProbeConstants.EXTENDED_REQUEST_SPACING_MS)
    }
}
