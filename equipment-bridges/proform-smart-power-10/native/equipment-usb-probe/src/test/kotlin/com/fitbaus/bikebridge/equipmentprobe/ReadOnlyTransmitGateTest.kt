// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.policy.DiagnosticBudget
import com.fitbaus.bikebridge.equipmentprobe.policy.ReadOnlyTransmitGate
import com.fitbaus.bikebridge.equipmentprobe.policy.SessionTransmitAuthorization
import com.fitbaus.bikebridge.equipmentprobe.policy.TransmitDecision
import com.fitbaus.bikebridge.equipmentprobe.session.BudgetExhaustedException
import com.fitbaus.bikebridge.equipmentprobe.session.GatedEquipmentExchange
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeExchangeResult
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.equipmentprobe.usb.ValidatedProbeTransport
import com.fitbaus.bikebridge.protocol.BikeField
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentDevice
import com.fitbaus.bikebridge.protocol.EquipmentFrameCodec
import com.fitbaus.bikebridge.protocol.EquipmentRequests
import com.fitbaus.bikebridge.protocol.IdentityResult
import com.fitbaus.bikebridge.protocol.MachineIdentity
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ReadOnlyTransmitGateTest {
    @Test
    fun allowsApprovedIdentityAndReadPacketsWhenConfirmed() {
        val auth = SessionTransmitAuthorization.Confirmed(EquipmentDevice.MAIN.id)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.deviceInfo().encode(), auth) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.systemInfo().encode(), auth) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.versionInfo().encode(), auth) is TransmitDecision.Allow)
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(
                EquipmentRequests.read(EquipmentDevice.MAIN, listOf(BikeField.WATTS, BikeField.RPM)).encode(),
                auth,
            ) is TransmitDecision.Allow,
        )
    }

    @Test
    fun mainOnlyDefaultAllowsDeviceInfoMainOnly() {
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.deviceInfo().encode()) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.systemInfo().encode()) is TransmitDecision.Reject)
    }

    @Test
    fun rejectsVerifySecurityPacketBytes() {
        val packet = EquipmentRequests.verifySecurity(sampleIdentity()).encode()
        val decision = ReadOnlyTransmitGate.validateOutgoing(
            packet,
            SessionTransmitAuthorization.Confirmed(EquipmentDevice.MAIN.id),
        )
        assertTrue(decision is TransmitDecision.Reject)
        assertTrue((decision as TransmitDecision.Reject).reason.contains("VerifySecurity"))
    }

    @Test
    fun rejectsReadWriteDataWithNonEmptyWriteSection() {
        val content = byteArrayOf(0x01, 0x01, 0x05, 0x01, 0x08)
        val packet = craft(EquipmentDevice.MAIN.id, EquipmentCommand.READ_WRITE_DATA.id, content)
        val decision = ReadOnlyTransmitGate.validateOutgoing(
            packet,
            SessionTransmitAuthorization.Confirmed(EquipmentDevice.MAIN.id),
        )
        assertTrue(decision is TransmitDecision.Reject)
        assertTrue((decision as TransmitDecision.Reject).reason.contains("write section"))
    }

    @Test
    fun rejectsNonMainDeviceIdsUntilAwaitingOrConfirmed() {
        val packet = craft(7, EquipmentCommand.DEVICE_INFO.id, ByteArray(0))
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(packet) is TransmitDecision.Reject)
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(packet, SessionTransmitAuthorization.AwaitingConfirmation(7))
                is TransmitDecision.Allow,
        )
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(packet, SessionTransmitAuthorization.Confirmed(7))
                is TransmitDecision.Allow,
        )
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(
                craft(4, EquipmentCommand.DEVICE_INFO.id, ByteArray(0)),
                SessionTransmitAuthorization.Confirmed(7),
            ) is TransmitDecision.Reject,
        )
    }

    @Test
    fun rejectsArbitraryCommandIds() {
        val packet = craft(EquipmentDevice.MAIN.id, 9, ByteArray(0))
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(
                packet,
                SessionTransmitAuthorization.Confirmed(EquipmentDevice.MAIN.id),
            ) is TransmitDecision.Reject,
        )
    }

    @Test
    fun rejectsMalformedChecksumAndLength() {
        val good = EquipmentRequests.deviceInfo().encode()
        val badChecksum = good.copyOf().also { it[it.lastIndex] = (it[it.lastIndex] + 1).toByte() }
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(badChecksum) is TransmitDecision.Reject)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(byteArrayOf(0x02, 0x03, 0x81.toByte())) is TransmitDecision.Reject)
    }

    @Test
    fun gatedExchangeBlocksVerifySecurityBeforeTransport() {
        val transport = ScriptedTransport(listOf(TransportResult.Ok(ByteArray(0))))
        transport.transmitAllowlist()!!.beginAwaitingConfirmation(EquipmentDevice.MAIN.id)
        transport.transmitAllowlist()!!.confirmSessionPrimary(EquipmentDevice.MAIN.id)
        val gated = GatedEquipmentExchange(transport, DiagnosticBudget(12))
        val result = gated.exchange(EquipmentRequests.verifySecurity(sampleIdentity()))
        assertTrue(result is ProbeExchangeResult.Failed)
        assertEquals(TransportFailureClass.POLICY_REJECTED, (result as ProbeExchangeResult.Failed).classification)
        assertEquals(0, transport.sent.size)
    }

    @Test
    fun validatedTransportRejectsRawBypassWithZeroOutCalls() {
        val inner = ScriptedTransport(listOf(TransportResult.Ok(ByteArray(0))))
        inner.transmitAllowlist()!!.beginAwaitingConfirmation(EquipmentDevice.MAIN.id)
        inner.transmitAllowlist()!!.confirmSessionPrimary(EquipmentDevice.MAIN.id)
        val validated = ValidatedProbeTransport(inner)
        val forged = EquipmentRequests.verifySecurity(sampleIdentity()).encode()
        val result = validated.exchange(forged)
        assertTrue(result is TransportResult.Failed)
        assertEquals(TransportFailureClass.POLICY_REJECTED, (result as TransportResult.Failed).classification)
        assertEquals(0, validated.outAttempts)
        assertEquals(1, validated.rejectedBeforeOut)
        assertEquals(0, inner.sent.size)
    }

    @Test
    fun gatedExchangeRespectsBudget() {
        val transport = ScriptedTransport(
            listOf(TransportResult.Ok(hex("02 0B 81 02 56 00 15 CD 5B 07 2A"))),
        )
        val gated = GatedEquipmentExchange(transport, DiagnosticBudget(1))
        gated.exchange(EquipmentRequests.deviceInfo())
        assertThrows(BudgetExhaustedException::class.java) {
            gated.exchange(EquipmentRequests.systemInfo())
        }
    }

    private fun sampleIdentity(): MachineIdentity {
        val deviceInfo = EquipmentRequests.deviceInfo().parse(hex("02 0B 81 02 56 00 15 CD 5B 07 2A"))
            as IdentityResult.Parsed
        val systemInfo = EquipmentRequests.systemInfo().parse(
            hex("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58"),
        ) as IdentityResult.Parsed
        val versionInfo = EquipmentRequests.versionInfo().parse(hex("02 06 84 02 54 E2"))
            as IdentityResult.Parsed
        return MachineIdentity.of(deviceInfo.value, systemInfo.value, versionInfo.value)
    }

    private fun craft(deviceId: Int, commandId: Int, content: ByteArray): ByteArray {
        val length = content.size + EquipmentFrameCodec.REQUEST_OVERHEAD
        val frame = ByteArray(length)
        frame[0] = deviceId.toByte()
        frame[1] = length.toByte()
        frame[2] = commandId.toByte()
        content.copyInto(frame, 3)
        frame[length - 1] = EquipmentFrameCodec.checksum(frame, length).toByte()
        return frame
    }
}
