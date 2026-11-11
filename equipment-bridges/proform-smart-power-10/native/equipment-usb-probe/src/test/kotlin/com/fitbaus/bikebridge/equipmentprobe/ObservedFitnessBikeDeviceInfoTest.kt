// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.policy.ReadOnlyTransmitGate
import com.fitbaus.bikebridge.equipmentprobe.policy.TransmitAllowlist
import com.fitbaus.bikebridge.equipmentprobe.policy.TransmitDecision
import com.fitbaus.bikebridge.equipmentprobe.report.DiagnosticReportWriter
import com.fitbaus.bikebridge.equipmentprobe.session.BasicProbeSequence
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeEvent
import com.fitbaus.bikebridge.equipmentprobe.session.ProbePhase
import com.fitbaus.bikebridge.equipmentprobe.session.StopKind
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentDevice
import com.fitbaus.bikebridge.protocol.EquipmentFrameCodec
import com.fitbaus.bikebridge.protocol.EquipmentRequests
import com.fitbaus.bikebridge.protocol.EquipmentStatus
import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class ObservedFitnessBikeDeviceInfoTest {
    @TempDir
    lateinit var tempDir: File

    @Test
    fun allowlistPermitsFitnessBikeDeviceInfoOnlyWhileAwaitingThenConfirmed() {
        val allowlist = TransmitAllowlist()
        val fitnessPacket = craft(EquipmentDeviceIds.FITNESS_BIKE, EquipmentCommand.DEVICE_INFO.id, ByteArray(0))
        val systemPacket = EquipmentRequests.systemInfo(EquipmentDevice.of(EquipmentDeviceIds.FITNESS_BIKE)).encode()
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(fitnessPacket, allowlist.state()) is TransmitDecision.Reject)

        allowlist.beginAwaitingConfirmation(EquipmentDeviceIds.FITNESS_BIKE)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(fitnessPacket, allowlist.state()) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(systemPacket, allowlist.state()) is TransmitDecision.Reject)

        allowlist.confirmSessionPrimary(EquipmentDeviceIds.FITNESS_BIKE)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(fitnessPacket, allowlist.state()) is TransmitDecision.Allow)
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(systemPacket, allowlist.state()) is TransmitDecision.Allow)
        val verify = craft(EquipmentDeviceIds.FITNESS_BIKE, 0x90, ByteArray(36) { 0 })
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(verify, allowlist.state()) is TransmitDecision.Reject)
    }

    @Test
    fun reportRecordsPrimaryDeviceAdoptionWithoutIdentityPayload() {
        val bikeInfo = legacyFitnessBikeDeviceInfo().copyOf(64).also { it[63] = 0x7E }
        val system = retargetFrame(hex("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58"), EquipmentDeviceIds.FITNESS_BIKE)
        val version = retargetFrame(hex("02 06 84 02 54 E2"), EquipmentDeviceIds.FITNESS_BIKE)
        val watts = retargetFrame(hex("02 09 02 02 96 00 48 00 ED"), EquipmentDeviceIds.FITNESS_BIKE)
        val optional = response(
            device = EquipmentDevice.FITNESS_BIKE,
            command = EquipmentCommand.READ_WRITE_DATA,
            status = EquipmentStatus.DONE,
            data = byteArrayOf(24),
        )
        val transport = ScriptedTransport(
            listOf(
                TransportResult.Ok(bikeInfo),
                TransportResult.Ok(legacyFitnessBikeDeviceInfo()),
                TransportResult.Ok(system),
                TransportResult.Ok(version),
                TransportResult.Ok(watts),
                TransportResult.Ok(optional),
                TransportResult.Ok(retargetFrame(optional, EquipmentDeviceIds.FITNESS_BIKE)),
                TransportResult.Ok(response(EquipmentDevice.FITNESS_BIKE, EquipmentCommand.READ_WRITE_DATA, EquipmentStatus.DONE, byteArrayOf(2))),
                TransportResult.Ok(response(EquipmentDevice.FITNESS_BIKE, EquipmentCommand.READ_WRITE_DATA, EquipmentStatus.DONE, byteArrayOf(1))),
                TransportResult.Ok(response(EquipmentDevice.FITNESS_BIKE, EquipmentCommand.READ_WRITE_DATA, EquipmentStatus.DONE, byteArrayOf(5))),
                TransportResult.Ok(response(EquipmentDevice.FITNESS_BIKE, EquipmentCommand.READ_WRITE_DATA, EquipmentStatus.DONE, byteArrayOf(5))),
            ),
        )
        val outcome = BasicProbeSequence(transport, sleeper = {}).run()
        assertEquals(StopKind.NONE, outcome.stopKind)
        assertEquals(EquipmentDeviceIds.FITNESS_BIKE, outcome.primaryDeviceId)
        val file = DiagnosticReportWriter(tempDir).write(ProbePhase.BASIC, outcome.events, outcome.summary)
        val text = file.readText()
        assertTrue(text.contains("PRIMARY_DEVICE_ADOPTED"))
        assertTrue(text.contains("primary=7"))
        assertTrue(text.contains("name=FITNESS_BIKE"))
        assertTrue(text.contains("fromResponseDeviceMismatch=true"))
        assertTrue(text.contains("confirmed=true"))
        assertFalse(text.contains("0A0B0C0D"))
        assertFalse(text.contains("serial="))
        assertTrue(outcome.events.any { it is ProbeEvent.PrimaryDeviceAdopted })
    }

    @Test
    fun transmitGateStillRejectsFitnessBikeBeforeAdoption() {
        val packet = craft(EquipmentDeviceIds.FITNESS_BIKE, EquipmentCommand.DEVICE_INFO.id, ByteArray(0))
        assertTrue(ReadOnlyTransmitGate.validateOutgoing(packet) is TransmitDecision.Reject)
        assertEquals(EquipmentDevice.MAIN.id, com.fitbaus.bikebridge.protocol.EquipmentRequests.deviceInfo().device.id)
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
