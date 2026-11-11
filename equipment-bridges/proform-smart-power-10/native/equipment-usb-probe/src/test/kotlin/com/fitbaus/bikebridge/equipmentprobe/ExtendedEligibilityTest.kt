// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.policy.ExtendedEligibility
import com.fitbaus.bikebridge.equipmentprobe.policy.ExtendedQualificationState
import com.fitbaus.bikebridge.equipmentprobe.session.ProbePhase
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeSessionRunner
import com.fitbaus.bikebridge.equipmentprobe.session.SessionReport
import com.fitbaus.bikebridge.equipmentprobe.session.StopKind
import com.fitbaus.bikebridge.equipmentprobe.usb.OpenResult
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualification
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualificationResult
import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class ExtendedEligibilityTest {
    @TempDir
    lateinit var tempDir: File

    @Test
    fun f2_3NeverAuthorizesExtendedFromBasicPrimaryDevice() {
        val qualified = UsbQualification.qualify(listOf(matchingBrainboard())) as UsbQualificationResult.Qualified
        val ok = SessionReport(
            ProbePhase.BASIC,
            "ok",
            StopKind.NONE,
            true,
            true,
            null,
            emptyList(),
            primaryDeviceId = EquipmentDeviceIds.FITNESS_BIKE,
        )
        val state = ExtendedEligibility.fromBasicReport(ok, qualified, primaryEquipmentDeviceId = EquipmentDeviceIds.FITNESS_BIKE)
        assertFalse(state.eligible)
        assertNull(state.primaryEquipmentDeviceId)
        assertNull(state.qualifiedDeviceName)
        assertTrue(state.reason.contains("F2.3"))
    }

    @Test
    fun stillEligibleCannotReviveAStaleEligibleFlag() {
        val qualified = UsbQualification.qualify(listOf(matchingBrainboard())) as UsbQualificationResult.Qualified
        val stale = ExtendedQualificationState(
            eligible = true,
            qualifiedDeviceName = qualified.device.deviceName,
            reason = "stale",
            primaryEquipmentDeviceId = EquipmentDeviceIds.FITNESS_BIKE,
        )
        val refreshed = ExtendedEligibility.stillEligible(stale, qualified)
        assertFalse(refreshed.eligible)
        assertNull(refreshed.primaryEquipmentDeviceId)
        assertTrue(refreshed.reason.contains("F2.3"))
    }

    @Test
    fun successfulBasicDoesNotEnableExtendedOrReopenUsb() {
        val device = matchingBrainboard()
        var openCount = 0
        val gateway = FakeUsbGateway(listOf(device), openHandler = {
            openCount += 1
            OpenResult.Opened(basicSuccessTransport())
        })
        gateway.grant(device.deviceName)
        val runner = ProbeSessionRunner(gateway, tempDir) { true }
        assertEquals(StopKind.NONE, runner.runBasic { false }.stopKind)
        assertFalse(runner.extendedQualification.eligible)
        assertTrue(runner.extendedQualification.reason.contains("F2.3"))
        val opensAfterBasic = openCount
        val extended = runner.runExtended { false }
        assertTrue(extended.outcome.contains("not authorized"))
        assertEquals(StopKind.QUALIFICATION_FAILED, extended.stopKind)
        assertEquals(opensAfterBasic, openCount)
        assertFalse(runner.extendedQualification.eligible)
    }

    @Test
    fun secondExtendedAttemptAlsoRefusesWithoutOpening() {
        val device = matchingBrainboard()
        var openCount = 0
        val gateway = FakeUsbGateway(listOf(device), openHandler = {
            openCount += 1
            OpenResult.Opened(basicSuccessTransport())
        })
        gateway.grant(device.deviceName)
        val runner = ProbeSessionRunner(gateway, tempDir) { true }
        runner.runBasic { false }
        val opensAfterBasic = openCount
        assertTrue(runner.runExtended { false }.outcome.contains("not authorized"))
        assertTrue(runner.runExtended { false }.outcome.contains("not authorized"))
        assertEquals(opensAfterBasic, openCount)
    }
}
