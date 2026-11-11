// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.policy

import com.fitbaus.bikebridge.protocol.BikeField
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentDevice
import com.fitbaus.bikebridge.protocol.EquipmentFrameCodec
import com.fitbaus.bikebridge.protocol.EquipmentRequests
import com.fitbaus.bikebridge.protocol.IdentityResult
import com.fitbaus.bikebridge.protocol.MachineIdentity
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ReadOnlyTransmitGateTest {
    private val bike = EquipmentDevice.FITNESS_BIKE
    private val confirmed = SessionTransmitAuthorization.Confirmed(bike.id)
    private val confirmedVerify = SessionTransmitAuthorization.Confirmed(bike.id, allowVerifySecurity = true)

    @Test
    fun confirmedAllowsMainIdentityReadsWhenPrimaryIsFitnessBike() {
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.systemInfo().encode(), confirmed) is TransmitDecision.Allow,
        )
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.versionInfo().encode(), confirmed) is TransmitDecision.Allow,
        )
        val vsMain = ReadOnlyTransmitGate.validateOutgoing(
            EquipmentRequests.verifySecurity(sampleIdentity()).encode(),
            confirmedVerify,
        )
        assertTrue(vsMain is TransmitDecision.Reject, vsMain.toString())
        assertTrue((vsMain as TransmitDecision.Reject).reason.contains("MAIN only for identity"), vsMain.reason)

        val writeMain = ReadOnlyTransmitGate.validateOutgoing(
            EquipmentRequests.writeResistance(EquipmentDevice.MAIN, 3, 22).encode(),
            SessionTransmitAuthorization.Confirmed(bike.id, allowResistanceWrite = true),
        )
        assertTrue(writeMain is TransmitDecision.Reject, writeMain.toString())
        assertTrue((writeMain as TransmitDecision.Reject).reason.contains("MAIN only for identity"), writeMain.reason)
    }

    @Test
    fun confirmedAllowsIdentityAndTelemetryReadsWithoutVerifySecurity() {
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.deviceInfo(bike).encode(), confirmed) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.systemInfo(bike).encode(), confirmed) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.versionInfo(bike).encode(), confirmed) is TransmitDecision.Allow)
        assertTrue(
            ReadOnlyTransmitGate.validateOutgoing(
                EquipmentRequests.read(bike, listOf(BikeField.WATTS, BikeField.RPM)).encode(),
                confirmed,
            ) is TransmitDecision.Allow,
        )
        val vs = ReadOnlyTransmitGate.validateOutgoing(EquipmentRequests.verifySecurity(sampleIdentity(), bike).encode(), confirmed)
        assertTrue(vs is TransmitDecision.Reject)
        assertTrue((vs as TransmitDecision.Reject).reason.contains("VerifySecurity"))
    }

    @Test
    fun confirmedAllowsExactlyOneQualifiedVerifySecurityWhenPermitted() {
        val packet = EquipmentRequests.verifySecurity(sampleIdentity(), bike).encode()
        assertEquals(40, packet.size)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(packet, confirmedVerify) is TransmitDecision.Allow)

        val shortContent = craft(bike.id, EquipmentCommand.VERIFY_SECURITY.id, ByteArray(35) { 1 })
        val short = ReadOnlyTransmitGate.validateOutgoing(shortContent, confirmedVerify)
        assertTrue(short is TransmitDecision.Reject)
        assertTrue((short as TransmitDecision.Reject).reason.contains("content length"))

        val longContent = craft(bike.id, EquipmentCommand.VERIFY_SECURITY.id, ByteArray(37) { 1 })
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(longContent, confirmedVerify) is TransmitDecision.Reject)
    }

    @Test
    fun rejectUnauthorizedWritesAndFirmware() {
        val resistance = craft(bike.id, EquipmentCommand.READ_WRITE_DATA.id, byteArrayOf(0x01, 0x04, 0x00, 0x00, 0x00))
        val workout = craft(bike.id, EquipmentCommand.READ_WRITE_DATA.id, byteArrayOf(0x02, 0x00, 0x10, 0x01, 0x00))
        val lockoutMask = ByteArray(14)
        lockoutMask[0] = 12
        lockoutMask[12] = 0x80.toByte()
        val lockout = craft(bike.id, EquipmentCommand.READ_WRITE_DATA.id, lockoutMask)
        for (packet in listOf(resistance, workout, lockout)) {
            val decision = ReadOnlyTransmitGate.validateOutgoing(packet, confirmedVerify)
            assertTrue(decision is TransmitDecision.Reject, decision.toString())
            assertTrue((decision as TransmitDecision.Reject).reason.contains("write section"), decision.reason)
        }
        for (command in listOf(3, 4, 5, 6, 9, 56, 112, 113, 128, 136, 137, 146, 255)) {
            val decision = ReadOnlyTransmitGate.validateOutgoing(craft(bike.id, command, ByteArray(0)), confirmedVerify)
            assertTrue(decision is TransmitDecision.Reject, "command $command: $decision")
        }
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(byteArrayOf(0x07, 0x02, 0x00), confirmedVerify) is TransmitDecision.Reject)
    }

    @Test
    fun confirmedResistanceWriteAllowsField2OnlyWhenPermitted() {
        val packet = EquipmentRequests.writeResistance(bike, 2, 22).encode()
        val denied = ReadOnlyTransmitGate.validateOutgoing(packet, confirmed)
        assertTrue(denied is TransmitDecision.Reject, denied.toString())
        assertTrue((denied as TransmitDecision.Reject).reason.contains("write section"))

        val allowedAuth = SessionTransmitAuthorization.Confirmed(bike.id, allowResistanceWrite = true)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(packet, allowedAuth) is TransmitDecision.Allow)

        val workout = craft(bike.id, EquipmentCommand.READ_WRITE_DATA.id, byteArrayOf(0x02, 0x00, 0x10, 0x01, 0x00))
        val workoutDecision = ReadOnlyTransmitGate.validateOutgoing(workout, allowedAuth)
        assertTrue(workoutDecision is TransmitDecision.Reject, workoutDecision.toString())
        assertTrue(
            (workoutDecision as TransmitDecision.Reject).reason.contains("field 2") ||
                workoutDecision.reason.contains("mask count"),
            workoutDecision.reason,
        )
    }

    @Test
    fun permitResistanceWriteRequiresConfirmedAndIsRevocable() {
        val allowlist = TransmitAllowlist()
        try {
            allowlist.permitResistanceWrite()
            throw AssertionError("permitResistanceWrite should require CONFIRMED")
        } catch (_: IllegalArgumentException) {
        }
        allowlist.beginAwaitingConfirmation(bike.id)
        allowlist.confirmSessionPrimary(bike.id)
        allowlist.permitResistanceWrite()
        assertTrue((allowlist.state() as SessionTransmitAuthorization.Confirmed).allowResistanceWrite)
        allowlist.revokeResistanceWrite()
        assertTrue(!(allowlist.state() as SessionTransmitAuthorization.Confirmed).allowResistanceWrite)
    }

    @Test
    fun confirmedIdleModeLockoutAllowsField95TrueOnlyWhenPermitted() {
        val packet = EquipmentRequests.writeIdleModeLockout(bike).encode()
        val denied = ReadOnlyTransmitGate.validateOutgoing(packet, confirmed)
        assertTrue(denied is TransmitDecision.Reject, denied.toString())
        assertTrue((denied as TransmitDecision.Reject).reason.contains("write section"))

        val allowed = SessionTransmitAuthorization.Confirmed(bike.id, allowIdleModeLockout = true)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(packet, allowed) is TransmitDecision.Allow)

        val field2 = EquipmentRequests.writeResistance(bike, 2, 22).encode()
        val mixed = ReadOnlyTransmitGate.validateOutgoing(field2, allowed)
        assertTrue(mixed is TransmitDecision.Reject, mixed.toString())
    }

    @Test
    fun permitIdleModeLockoutRequiresConfirmedAndIsRevocable() {
        val allowlist = TransmitAllowlist()
        try {
            allowlist.permitIdleModeLockout()
            throw AssertionError("permitIdleModeLockout should require CONFIRMED")
        } catch (_: IllegalArgumentException) {
        }
        allowlist.beginAwaitingConfirmation(bike.id)
        allowlist.confirmSessionPrimary(bike.id)
        allowlist.permitIdleModeLockout()
        assertTrue((allowlist.state() as SessionTransmitAuthorization.Confirmed).allowIdleModeLockout)
        allowlist.revokeIdleModeLockout()
        assertTrue(!(allowlist.state() as SessionTransmitAuthorization.Confirmed).allowIdleModeLockout)
    }

    @Test
    fun permitVerifySecurityRequiresConfirmedAndIsRevocable() {
        val allowlist = TransmitAllowlist()
        try {
            allowlist.permitVerifySecurity()
            throw AssertionError("permitVerifySecurity should require CONFIRMED")
        } catch (_: IllegalArgumentException) {
        }
        allowlist.beginAwaitingConfirmation(bike.id)
        try {
            allowlist.permitVerifySecurity()
            throw AssertionError("permitVerifySecurity should require CONFIRMED")
        } catch (_: IllegalArgumentException) {
        }
        allowlist.confirmSessionPrimary(bike.id)
        allowlist.permitVerifySecurity()
        assertTrue((allowlist.state() as SessionTransmitAuthorization.Confirmed).allowVerifySecurity)
        allowlist.revokeVerifySecurity()
        assertTrue(!(allowlist.state() as SessionTransmitAuthorization.Confirmed).allowVerifySecurity)
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

    private fun hex(text: String): ByteArray {
        val clean = text.replace(" ", "")
        return ByteArray(clean.length / 2) { clean.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
