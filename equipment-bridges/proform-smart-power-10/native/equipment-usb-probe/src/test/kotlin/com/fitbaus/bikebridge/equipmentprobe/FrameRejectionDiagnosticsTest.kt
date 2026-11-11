// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.report.DiagnosticReportWriter
import com.fitbaus.bikebridge.equipmentprobe.session.BasicProbeSequence
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeEvent
import com.fitbaus.bikebridge.equipmentprobe.session.ProbePhase
import com.fitbaus.bikebridge.equipmentprobe.session.StopKind
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class FrameRejectionDiagnosticsTest {
    @TempDir
    lateinit var tempDir: File

    @Test
    fun surfacesExactFrameRejectionForCorruptDeviceInfoChecksum() {
        val bad = hex("02 0B 81 02 56 00 15 CD 5B 07 2B")
        val transport = ScriptedTransport(listOf(TransportResult.Ok(bad)))
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.MALFORMED, outcome.stopKind)
        assertTrue(outcome.summary.contains("CHECKSUM_MISMATCH"))

        val observed = outcome.events.filterIsInstance<ProbeEvent.ResponseObserved>().single()
        assertEquals(EquipmentCommand.DEVICE_INFO, observed.command)
        assertEquals(11, observed.frameLength)
        assertEquals(11, observed.declaredLength)
        assertTrue(observed.checksumEvaluated)
        assertFalse(observed.checksumValid)
        assertEquals("CHECKSUM_MISMATCH", observed.frameRejection)
        assertTrue(observed.frameRejectionDetail!!.contains("expected"))
        assertEquals(2, observed.headerDeviceId)
        assertEquals(0x81, observed.headerCommandId)
        assertEquals(2, observed.headerStatusCode)
        assertTrue(observed.parseSummary.contains("CHECKSUM_MISMATCH") || observed.parseSummary.contains("MALFORMED_FRAME"))
        assertTrue(observed.parseSummary.contains("BootstrapRejected") || observed.parseSummary.contains("CHECKSUM_MISMATCH"))
        assertFalse(observed.parseSummary.contains("15 CD 5B 07"))
    }

    @Test
    fun deviceMismatchAfterValidChecksumReportsChecksumValid() {
        // Valid Watts/Rpm frame on device 4 — checksum passes, device mismatches MAIN DeviceInfo.
        val wrongDevice = hex("04 09 02 02 96 00 48 00 EF")
        val transport = ScriptedTransport(listOf(TransportResult.Ok(wrongDevice)))
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        val observed = outcome.events.filterIsInstance<ProbeEvent.ResponseObserved>().single()
        assertEquals("DEVICE_MISMATCH", observed.frameRejection)
        assertTrue(observed.checksumEvaluated)
        assertTrue(observed.checksumValid)
        assertEquals(4, observed.headerDeviceId)
        assertEquals(2, observed.headerCommandId)
        assertTrue(outcome.summary.contains("ordinary device mismatch"))
        assertTrue(observed.parseSummary.startsWith("OrdinaryDeviceMismatch"))
    }

    @Test
    fun sixtyFourBytePaddedValidDeviceInfoIsAccepted() {
        val short = hex("02 0B 81 02 56 00 15 CD 5B 07 2A")
        val padded = short.copyOf(64)
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(padded),
                TransportResult.Ok(short), // confirmation DeviceInfo(MAIN)
                TransportResult.Ok(hex("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58")),
                TransportResult.Ok(hex("02 06 84 02 54 E2")),
                TransportResult.Ok(hex("02 09 02 02 96 00 48 00 ED")),
            ) + telemetryHappyPathResponses.drop(1).map { TransportResult.Ok(it) },
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.NONE, outcome.stopKind)
        val first = outcome.events.filterIsInstance<ProbeEvent.ResponseObserved>().first()
        assertEquals(64, first.frameLength)
        assertEquals(11, first.declaredLength)
        assertEquals(53, first.trailingPaddingBytes)
        assertEquals(true, first.trailingPaddingAllZero)
        assertTrue(first.checksumValid)
    }

    @Test
    fun reportIncludesStructuralFieldsWithoutIdentityPayload() {
        val bad = hex("02 0B 81 02 56 00 15 CD 5B 07 2B")
        val transport = ScriptedTransport(listOf(TransportResult.Ok(bad)))
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        val file = DiagnosticReportWriter(tempDir).write(ProbePhase.BASIC, outcome.events, outcome.summary)
        val text = file.readText()
        assertTrue(text.contains("transferLength=11"))
        assertTrue(text.contains("declaredLength=11"))
        assertTrue(text.contains("frameRejection=CHECKSUM_MISMATCH"))
        assertTrue(text.contains("checksumEvaluated=true"))
        assertTrue(text.contains("checksumValid=false"))
        assertTrue(text.contains("headerDeviceId=2"))
        assertTrue(text.contains("headerCommandId=129"))
        assertFalse(text.contains("123456789"))
        assertFalse(text.contains("15 CD 5B 07"))
        assertFalse(text.contains("serial="))
    }

    @Test
    fun encodesDeviceInfoIdenticalToLegacyDerivedFixture() {
        val transport = ScriptedTransport(listOf(TransportResult.Ok(hex("02 05 81 08 90"))))
        BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(1, transport.sent.size)
        assertEquals(hex("02 04 81 87").toList(), transport.sent[0].toList())
    }
}
