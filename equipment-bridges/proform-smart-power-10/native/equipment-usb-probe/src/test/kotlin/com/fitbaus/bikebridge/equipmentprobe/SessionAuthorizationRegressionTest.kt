// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.policy.ReadOnlyTransmitGate
import com.fitbaus.bikebridge.equipmentprobe.policy.SessionTransmitAuthorization
import com.fitbaus.bikebridge.equipmentprobe.policy.TransmitAllowlist
import com.fitbaus.bikebridge.equipmentprobe.policy.TransmitDecision
import com.fitbaus.bikebridge.equipmentprobe.session.BasicProbeSequence
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeSessionRunner
import com.fitbaus.bikebridge.equipmentprobe.session.StopKind
import com.fitbaus.bikebridge.equipmentprobe.usb.OpenResult
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.equipmentprobe.usb.ValidatedProbeTransport
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentDevice
import com.fitbaus.bikebridge.protocol.EquipmentFrameCodec
import com.fitbaus.bikebridge.protocol.EquipmentRequests
import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/**
 * Proves FitnessBike TX is never available on a newly opened USB session until
 * that session completes its own PrimaryDevice bootstrap/confirmation.
 */
class SessionAuthorizationRegressionTest {
    @TempDir
    lateinit var tempDir: File

    @Test
    fun freshTransmitAllowlistRejectsFitnessBikeUntilAwaitingConfirmation() {
        val allowlist = TransmitAllowlist()
        val bikeDeviceInfo = craft(EquipmentDeviceIds.FITNESS_BIKE, EquipmentCommand.DEVICE_INFO.id)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(bikeDeviceInfo, allowlist.state()) is TransmitDecision.Reject)
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(
                EquipmentRequests.deviceInfo(EquipmentDevice.MAIN).encode(),
                allowlist.state(),
            ) is TransmitDecision.Allow,
        )
        allowlist.beginAwaitingConfirmation(EquipmentDeviceIds.FITNESS_BIKE)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(bikeDeviceInfo, allowlist.state()) is TransmitDecision.Allow)
    }

    @Test
    fun validatedTransportOnNewSessionRejectsFitnessBikeWithZeroOutCalls() {
        val inner = ScriptedTransport(listOf(TransportResult.Ok(ByteArray(0))))
        val validated = ValidatedProbeTransport(inner, inner.transmitAllowlist()!!)
        val forged = craft(EquipmentDeviceIds.FITNESS_BIKE, EquipmentCommand.DEVICE_INFO.id)
        val result = validated.exchange(forged)
        assertTrue(result is TransportResult.Failed)
        assertEquals(TransportFailureClass.POLICY_REJECTED, (result as TransportResult.Failed).classification)
        assertEquals(0, validated.outAttempts)
        assertEquals(1, validated.rejectedBeforeOut)
        assertEquals(0, inner.sent.size)
        assertTrue(validated.transmitAllowlist()!!.state() is SessionTransmitAuthorization.MainOnly)
    }

    @Test
    fun closingSessionResetsAllowlistSoNextOpenCannotReuseFitnessBike() {
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(legacyFitnessBikeDeviceInfo()),
                TransportResult.Ok(legacyFitnessBikeDeviceInfo()),
                TransportResult.Ok(retargetFrame(hex("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58"), EquipmentDeviceIds.FITNESS_BIKE)),
                TransportResult.Ok(retargetFrame(hex("02 06 84 02 54 E2"), EquipmentDeviceIds.FITNESS_BIKE)),
            ) + telemetryHappyPathResponses.map {
                TransportResult.Ok(retargetFrame(it, EquipmentDeviceIds.FITNESS_BIKE))
            },
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.NONE, outcome.stopKind)
        assertEquals(EquipmentDeviceIds.FITNESS_BIKE, outcome.primaryDeviceId)
        assertTrue(transport.transmitAllowlist()!!.state() is SessionTransmitAuthorization.Confirmed)

        transport.close()
        assertTrue(transport.transmitAllowlist()!!.state() is SessionTransmitAuthorization.MainOnly)

        val nextInner = ScriptedTransport(listOf(TransportResult.Ok(ByteArray(0))))
        val nextSession = ValidatedProbeTransport(nextInner, nextInner.transmitAllowlist()!!)
        val bikeTx = craft(EquipmentDeviceIds.FITNESS_BIKE, EquipmentCommand.SYSTEM_INFO.id)
        val blocked = nextSession.exchange(bikeTx)
        assertTrue(blocked is TransportResult.Failed)
        assertEquals(TransportFailureClass.POLICY_REJECTED, (blocked as TransportResult.Failed).classification)
        assertEquals(0, nextInner.sent.size)
        assertTrue(nextSession.transmitAllowlist()!!.state() is SessionTransmitAuthorization.MainOnly)
    }

    @Test
    fun priorBasicPrimaryDeviceIdDoesNotAuthorizeFitnessBikeOnExtendedOrNewOpen() {
        val device = matchingBrainboard()
        val priorPrimary = EquipmentDeviceIds.FITNESS_BIKE
        var openCount = 0
        val openedAllowlists = ArrayList<TransmitAllowlist>()
        val gateway = FakeUsbGateway(listOf(device), openHandler = {
            openCount += 1
            val transport = fitnessBikeBasicSuccessTransport()
            openedAllowlists += transport.transmitAllowlist()!!
            OpenResult.Opened(transport)
        })
        gateway.grant(device.deviceName)
        val runner = ProbeSessionRunner(gateway, tempDir) { true }
        val basic = runner.runBasic { false }
        assertEquals(StopKind.NONE, basic.stopKind)
        assertEquals(priorPrimary, basic.primaryDeviceId)
        assertFalse(runner.extendedQualification.eligible)
        assertNullPrimaryCarried(runner)

        val opensAfterBasic = openCount
        val extended = runner.runExtended { false }
        assertTrue(extended.outcome.contains("not authorized"))
        assertEquals(opensAfterBasic, openCount)
        assertEquals(1, openedAllowlists.size)

        val second = runner.runBasic { false }
        assertEquals(StopKind.NONE, second.stopKind)
        assertEquals(2, openCount)
        assertEquals(priorPrimary, second.primaryDeviceId)
        assertTrue(openedAllowlists[0].state() is SessionTransmitAuthorization.MainOnly)
    }

    @Test
    fun provisionalAwaitingDoesNotPermitSystemInfoUntilConfirm() {
        val allowlist = TransmitAllowlist()
        val confirmTx = EquipmentRequests.deviceInfo(EquipmentDevice.of(EquipmentDeviceIds.FITNESS_BIKE)).encode()
        val systemTx = EquipmentRequests.systemInfo(EquipmentDevice.of(EquipmentDeviceIds.FITNESS_BIKE)).encode()
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(confirmTx, allowlist.state()) is TransmitDecision.Reject)

        allowlist.beginAwaitingConfirmation(EquipmentDeviceIds.FITNESS_BIKE)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(confirmTx, allowlist.state()) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(systemTx, allowlist.state()) is TransmitDecision.Reject)

        allowlist.confirmSessionPrimary(EquipmentDeviceIds.FITNESS_BIKE)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(systemTx, allowlist.state()) is TransmitDecision.Allow)
    }

    private fun assertNullPrimaryCarried(runner: ProbeSessionRunner) {
        assertEquals(null, runner.extendedQualification.primaryEquipmentDeviceId)
    }

    private fun craft(deviceId: Int, commandId: Int): ByteArray {
        val length = EquipmentFrameCodec.REQUEST_OVERHEAD
        val frame = ByteArray(length)
        frame[0] = deviceId.toByte()
        frame[1] = length.toByte()
        frame[2] = commandId.toByte()
        frame[length - 1] = EquipmentFrameCodec.checksum(frame, length).toByte()
        return frame
    }

    private fun fitnessBikeBasicSuccessTransport(): ScriptedTransport {
        val systemInfo = hex("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58")
        val versionInfo = hex("02 06 84 02 54 E2")
        val responses = listOf(
            legacyFitnessBikeDeviceInfo(),
            legacyFitnessBikeDeviceInfo(),
            retargetFrame(systemInfo, EquipmentDeviceIds.FITNESS_BIKE),
            retargetFrame(versionInfo, EquipmentDeviceIds.FITNESS_BIKE),
        ) + telemetryHappyPathResponses.map { retargetFrame(it, EquipmentDeviceIds.FITNESS_BIKE) }
        return ScriptedTransport(responses.map { TransportResult.Ok(it) })
    }
}
