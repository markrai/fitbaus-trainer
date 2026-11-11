// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.session.ProbeSessionRunner
import com.fitbaus.bikebridge.equipmentprobe.session.StopKind
import com.fitbaus.bikebridge.equipmentprobe.usb.OpenResult
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class ProbeSessionRunnerTest {
    @TempDir
    lateinit var tempDir: File

    @Test
    fun permissionDeniedDoesNotOpen() {
        val gateway = FakeUsbGateway(listOf(matchingBrainboard()), openHandler = {
            error("should not open")
        })
        val runner = ProbeSessionRunner(gateway, tempDir) { false }
        val report = runner.runBasic { false }
        assertEquals(StopKind.PERMISSION_DENIED, report.stopKind)
        assertEquals(0, gateway.openCalls)
        assertFalse(runner.extendedQualification.eligible)
    }

    @Test
    fun claimFailureIsReported() {
        val device = matchingBrainboard()
        val gateway = FakeUsbGateway(listOf(device), openHandler = {
            OpenResult.Failed("claimInterface(force=false) failed", requiresForceClaimReview = true)
        })
        gateway.grant(device.deviceName)
        val report = ProbeSessionRunner(gateway, tempDir) { true }.runBasic { false }
        assertEquals(StopKind.CLAIM_FAILED, report.stopKind)
        assertTrue(report.events.any {
            it is com.fitbaus.bikebridge.equipmentprobe.session.ProbeEvent.Info &&
                it.message.contains("force-claim")
        })
    }

    @Test
    fun successfulRunClosesTransportWritesReportAndDoesNotAuthorizeExtended() {
        val device = matchingBrainboard()
        val transport = basicSuccessTransport()
        val gateway = FakeUsbGateway(listOf(device), openHandler = { OpenResult.Opened(transport) })
        gateway.grant(device.deviceName)
        val runner = ProbeSessionRunner(gateway, tempDir) { true }
        val report = runner.runBasic { false }
        assertTrue(transport.closed)
        assertTrue(report.reportFile != null && report.reportFile!!.exists())
        val text = report.reportFile!!.readText()
        assertFalse(text.contains("123456789"))
        assertFalse(text.contains("401234"))
        // F2.3: Basic PrimaryDevice must not authorize Extended on a new USB session.
        assertFalse(runner.extendedQualification.eligible)
        assertTrue(runner.extendedQualification.reason.contains("F2.3"))
    }

    @Test
    fun shortWriteFailsTransportWithoutLeakingOwnership() {
        val device = matchingBrainboard()
        val transport = object : com.fitbaus.bikebridge.equipmentprobe.usb.ProbeTransport {
            var closed = false
            override fun exchange(request: ByteArray) =
                TransportResult.Failed(com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass.PARTIAL_OUT_WRITE)
            override fun isAttached() = !closed
            override fun close() {
                closed = true
            }
        }
        val gateway = FakeUsbGateway(listOf(device), openHandler = { OpenResult.Opened(transport) })
        gateway.grant(device.deviceName)
        val report = ProbeSessionRunner(gateway, tempDir) { true }.runBasic { false }
        assertTrue(transport.closed)
        assertEquals(StopKind.TRANSPORT_FAILURE, report.stopKind)
    }

    @Test
    fun repeatedBasicRunsWorkAndFailedBasicClearsEligibility() {
        val device = matchingBrainboard()
        var openCount = 0
        val gateway = FakeUsbGateway(listOf(device), openHandler = {
            openCount += 1
            if (openCount == 1) {
                OpenResult.Opened(basicSuccessTransport())
            } else {
                OpenResult.Opened(ScriptedTransport(listOf(TransportResult.Ok(hex("02 05 81 08 90")))))
            }
        })
        gateway.grant(device.deviceName)
        val runner = ProbeSessionRunner(gateway, tempDir) { true }
        assertEquals(StopKind.NONE, runner.runBasic { false }.stopKind)
        assertFalse(runner.extendedQualification.eligible)
        assertEquals(StopKind.SECURITY_BLOCK, runner.runBasic { false }.stopKind)
        assertFalse(runner.extendedQualification.eligible)
        assertTrue(runner.runExtended { false }.outcome.contains("not authorized"))
    }
}
