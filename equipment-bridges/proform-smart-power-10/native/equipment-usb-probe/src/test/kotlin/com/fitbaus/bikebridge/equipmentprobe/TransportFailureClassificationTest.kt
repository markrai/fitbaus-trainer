// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.report.DiagnosticReportWriter
import com.fitbaus.bikebridge.equipmentprobe.session.BasicProbeSequence
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeEvent
import com.fitbaus.bikebridge.equipmentprobe.session.ProbePhase
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class TransportFailureClassificationTest {
    @TempDir
    lateinit var tempDir: File

    @Test
    fun classifiedFailuresSurviveIntoDiagnosticReport() {
        val classifications = listOf(
            TransportFailureClass.OUT_TRANSFER_FAILED,
            TransportFailureClass.PARTIAL_OUT_WRITE,
            TransportFailureClass.IN_TIMEOUT_OR_FAILURE,
            TransportFailureClass.DEVICE_DETACHED,
            TransportFailureClass.POLICY_REJECTED,
        )
        for (classification in classifications) {
            val transport = ScriptedTransport(
                listOf(TransportResult.Failed(classification)),
            )
            val outcome = BasicProbeSequence(transport, sleeper = {}).run()
            val observed = outcome.events.filterIsInstance<ProbeEvent.ResponseObserved>()
            assertTrue(observed.any { it.parseSummary == classification.reportToken }, classification.name)
            val report = DiagnosticReportWriter(tempDir).write(ProbePhase.BASIC, outcome.events, outcome.summary)
            val text = report.readText()
            assertTrue(text.contains(classification.reportToken), classification.name)
            assertFalse(text.contains("Exception"))
            assertFalse(text.contains("serial="))
        }
    }

    @Test
    fun policyRejectionUsesFixedTokenWithoutRawReasonLeakage() {
        val forged = com.fitbaus.bikebridge.protocol.EquipmentRequests.verifySecurity(
            run {
                val deviceInfo = com.fitbaus.bikebridge.protocol.EquipmentRequests.deviceInfo()
                    .parse(hex("02 0B 81 02 56 00 15 CD 5B 07 2A"))
                    as com.fitbaus.bikebridge.protocol.IdentityResult.Parsed
                val systemInfo = com.fitbaus.bikebridge.protocol.EquipmentRequests.systemInfo()
                    .parse(hex("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58"))
                    as com.fitbaus.bikebridge.protocol.IdentityResult.Parsed
                val versionInfo = com.fitbaus.bikebridge.protocol.EquipmentRequests.versionInfo()
                    .parse(hex("02 06 84 02 54 E2"))
                    as com.fitbaus.bikebridge.protocol.IdentityResult.Parsed
                com.fitbaus.bikebridge.protocol.MachineIdentity.of(deviceInfo.value, systemInfo.value, versionInfo.value)
            },
        ).encode()
        val inner = ScriptedTransport(emptyList())
        val validated = com.fitbaus.bikebridge.equipmentprobe.usb.ValidatedProbeTransport(inner)
        val result = validated.exchange(forged)
        assertTrue(result is TransportResult.Failed)
        assertTrue((result as TransportResult.Failed).classification == TransportFailureClass.POLICY_REJECTED)
        assertTrue(inner.sent.isEmpty())
    }
}
