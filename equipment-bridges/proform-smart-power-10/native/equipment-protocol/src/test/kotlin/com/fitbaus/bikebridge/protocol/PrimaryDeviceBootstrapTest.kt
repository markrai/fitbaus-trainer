// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class PrimaryDeviceBootstrapTest {
    @Test
    fun adoptsFitnessBikeFromMainRequestWhenFrameValid() {
        val raw = legacyShaped(deviceId = EquipmentDeviceIds.FITNESS_BIKE).copyOf(64)
        raw[40] = 0x11
        val result = PrimaryDeviceBootstrap.evaluate(EquipmentDevice.MAIN, raw)
        val adopted = assertIs<PrimaryDeviceBootstrapResult.Adopted>(result)
        assertEquals(EquipmentDevice.FITNESS_BIKE, adopted.primaryDevice)
        assertTrue(adopted.adoptedFromResponseDeviceMismatch)
        assertEquals(86, adopted.deviceInfo.softwareVersion)
    }

    @Test
    fun adoptsMainWhenResponseMatchesMain() {
        val raw = IdentityFixtures.deviceInfo.bytes()
        val result = PrimaryDeviceBootstrap.evaluate(EquipmentDevice.MAIN, raw)
        val adopted = assertIs<PrimaryDeviceBootstrapResult.Adopted>(result)
        assertEquals(EquipmentDevice.MAIN, adopted.primaryDevice)
        assertFalse(adopted.adoptedFromResponseDeviceMismatch)
    }

    @Test
    fun rejectsOrdinaryMismatchForUnknownDevice() {
        val raw = legacyShaped(deviceId = EquipmentDeviceIds.TREADMILL)
        val result = PrimaryDeviceBootstrap.evaluate(EquipmentDevice.MAIN, raw)
        val rejected = assertIs<PrimaryDeviceBootstrapResult.Rejected>(result)
        assertTrue(rejected.ordinaryDeviceMismatch)
        assertEquals("ORDINARY_DEVICE_MISMATCH", rejected.reason)
    }

    @Test
    fun rejectsBadChecksumWithoutAdoption() {
        val raw = legacyShaped(deviceId = EquipmentDeviceIds.FITNESS_BIKE)
        raw[raw.lastIndex] = (raw.last().toInt() xor 1).toByte()
        val result = PrimaryDeviceBootstrap.evaluate(EquipmentDevice.MAIN, raw)
        val rejected = assertIs<PrimaryDeviceBootstrapResult.Rejected>(result)
        assertFalse(rejected.ordinaryDeviceMismatch)
        assertEquals("MALFORMED_FRAME", rejected.reason)
    }

    @Test
    fun rejectsWrongCommand() {
        val raw = legacyShaped(deviceId = EquipmentDeviceIds.FITNESS_BIKE)
        raw[2] = EquipmentCommand.SYSTEM_INFO.id.toByte()
        raw[raw.lastIndex] = EquipmentFrameCodec.checksum(raw, raw.size).toByte()
        val result = PrimaryDeviceBootstrap.evaluate(EquipmentDevice.MAIN, raw)
        assertIs<PrimaryDeviceBootstrapResult.Rejected>(result)
    }

    @Test
    fun rejectsTruncatedIdentityPayload() {
        // Declared length too short for serial fields after header/status.
        val raw = byteArrayOf(0x07, 0x06, 0x81.toByte(), 0x02, 0x56, 0x00)
        raw[5] = EquipmentFrameCodec.checksum(raw, 6).toByte()
        val result = PrimaryDeviceBootstrap.evaluate(EquipmentDevice.MAIN, raw)
        val rejected = assertIs<PrimaryDeviceBootstrapResult.Rejected>(result)
        assertEquals("IDENTITY_REJECTED", rejected.reason)
    }

    @Test
    fun confirmationRequiresMatchingSoftwareAndSerial() {
        val first = legacyShaped(deviceId = EquipmentDeviceIds.FITNESS_BIKE, serial = 100L)
        val adopted = assertIs<PrimaryDeviceBootstrapResult.Adopted>(
            PrimaryDeviceBootstrap.evaluate(EquipmentDevice.MAIN, first),
        )
        val ok = PrimaryDeviceBootstrap.confirm(
            EquipmentDevice.FITNESS_BIKE,
            adopted.deviceInfo,
            legacyShaped(deviceId = EquipmentDeviceIds.FITNESS_BIKE, serial = 100L),
        )
        assertIs<PrimaryDeviceBootstrapResult.Adopted>(ok)

        val badSerial = PrimaryDeviceBootstrap.confirm(
            EquipmentDevice.FITNESS_BIKE,
            adopted.deviceInfo,
            legacyShaped(deviceId = EquipmentDeviceIds.FITNESS_BIKE, serial = 999L),
        )
        assertEquals(
            "CONFIRM_IDENTITY_MISMATCH",
            assertIs<PrimaryDeviceBootstrapResult.Rejected>(badSerial).reason,
        )

        val wrongDevice = PrimaryDeviceBootstrap.confirm(
            EquipmentDevice.FITNESS_BIKE,
            adopted.deviceInfo,
            legacyShaped(deviceId = EquipmentDeviceIds.MAIN, serial = 100L),
        )
        assertIs<PrimaryDeviceBootstrapResult.Rejected>(wrongDevice)
    }

    @Test
    fun strictDecoderStillRejectsFitnessBikeAgainstMain() {
        val raw = legacyShaped(deviceId = EquipmentDeviceIds.FITNESS_BIKE)
        assertEquals(
            FrameRejection.DEVICE_MISMATCH,
            assertIs<FrameParseResult.Rejected>(
                EquipmentFrameCodec.parseResponse(raw, EquipmentDevice.MAIN, EquipmentCommand.DEVICE_INFO),
            ).rejection,
        )
    }

    private fun legacyShaped(
        deviceId: Int,
        softwareVersion: Int = 86,
        serial: Long = 0x0A0B0C0DL,
        sectionCount: Int = 15,
    ): ByteArray {
        val dataLen = 1 + 1 + 4 + 2 + 1 + sectionCount
        val length = EquipmentFrameCodec.RESPONSE_HEADER_LENGTH + dataLen + 1
        val frame = ByteArray(length)
        frame[0] = deviceId.toByte()
        frame[1] = length.toByte()
        frame[2] = EquipmentCommand.DEVICE_INFO.id.toByte()
        frame[3] = EquipmentStatus.DONE.code!!.toByte()
        var i = 4
        frame[i++] = softwareVersion.toByte()
        frame[i++] = 1
        frame[i++] = (serial and 0xFF).toByte()
        frame[i++] = ((serial ushr 8) and 0xFF).toByte()
        frame[i++] = ((serial ushr 16) and 0xFF).toByte()
        frame[i++] = ((serial ushr 24) and 0xFF).toByte()
        frame[i++] = 1
        frame[i++] = 0
        frame[i++] = sectionCount.toByte()
        repeat(sectionCount) { frame[i++] = 0x01 }
        frame[length - 1] = EquipmentFrameCodec.checksum(frame, length).toByte()
        return frame
    }
}
