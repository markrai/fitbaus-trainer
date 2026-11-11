// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Deterministic fixtures matching F2.1 physical RX metadata:
 * transferLength=64, declaredLength=29, checksumValid, DEVICE_MISMATCH,
 * headerDeviceId=7, headerCommandId=129, headerStatusCode=2,
 * trailingPaddingBytes=35, trailingPaddingAllZero=false.
 *
 * Payload contents use synthetic non-production identity values.
 */
class ObservedDeviceInfoMismatchTest {
    @Test
    fun legacyShapedDeviceInfoLengthTwentyNineMatchesPhysicalDeclaredLength() {
        val frame = legacyShapedDeviceInfo(
            deviceId = EquipmentDeviceIds.FITNESS_BIKE,
            softwareVersion = 86,
            hardwareVersion = 1,
            serial = 0x0A0B0C0DL,
            manufacturer = 1,
            sectionCount = 15,
        )
        assertEquals(29, frame.size)
        assertEquals(29, frame[1].toInt() and 0xFF)
        assertEquals(EquipmentDeviceIds.FITNESS_BIKE, frame[0].toInt() and 0xFF)
        assertEquals(EquipmentCommand.DEVICE_INFO.id, frame[2].toInt() and 0xFF)
        assertEquals(EquipmentStatus.DONE.code, frame[3].toInt() and 0xFF)
        assertEquals(EquipmentFrameCodec.checksum(frame, 29), frame[28].toInt() and 0xFF)
    }

    @Test
    fun mainExpectationRejectsFitnessBikeResponseWithoutWeakeningMatch() {
        val frame = legacyShapedDeviceInfo(deviceId = EquipmentDeviceIds.FITNESS_BIKE).copyOf(64)
        // Non-zero trailing bytes — physical report had trailingPaddingAllZero=false.
        frame[40] = 0x11
        frame[63] = 0x22

        val summary = FrameDiagnostics.summarize(
            frame,
            EquipmentDevice.MAIN,
            EquipmentCommand.DEVICE_INFO,
        )
        assertEquals(64, summary.transferLength)
        assertEquals(29, summary.declaredLength)
        assertEquals(true, summary.checksumEvaluated)
        assertEquals(true, summary.checksumValid)
        assertEquals(FrameRejection.DEVICE_MISMATCH, summary.frameRejection)
        assertEquals(7, summary.headerDeviceId)
        assertEquals("FITNESS_BIKE", summary.headerDeviceName)
        assertEquals(129, summary.headerCommandId)
        assertEquals(2, summary.headerStatusCode)
        assertEquals(35, summary.trailingPaddingBytes)
        assertEquals(false, summary.trailingPaddingAllZero)
        assertTrue(summary.frameRejectionDetail!!.contains("FITNESS_BIKE"))
        assertTrue(summary.frameRejectionDetail!!.contains("MAIN"))

        val identity = EquipmentRequests.deviceInfo(EquipmentDevice.MAIN).parse(frame)
        assertIs<IdentityResult.Rejected>(identity)
        assertEquals(IdentityRejection.MALFORMED_FRAME, identity.reason)
        assertTrue(identity.detail.contains("DEVICE_MISMATCH"))
    }

    @Test
    fun fitnessBikeExpectationAcceptsSameFrameAndLegacyOffsets() {
        val frame = legacyShapedDeviceInfo(deviceId = EquipmentDeviceIds.FITNESS_BIKE).copyOf(64)
        frame[50] = 0x55

        val accepted = assertIs<FrameParseResult.Accepted>(
            EquipmentFrameCodec.parseResponse(
                frame,
                EquipmentDevice.FITNESS_BIKE,
                EquipmentCommand.DEVICE_INFO,
            ),
        ).frame
        assertEquals(EquipmentDeviceIds.FITNESS_BIKE, accepted.deviceId)
        assertEquals(24, accepted.dataLength)

        val parsed = assertIs<IdentityResult.Parsed<DeviceInfo>>(
            EquipmentRequests.deviceInfo(EquipmentDevice.FITNESS_BIKE).parse(frame),
        ).value
        assertEquals(86, parsed.softwareVersion)
        assertEquals(0x0A0B0C0DL, parsed.serialNumber)
    }

    @Test
    fun trailingRegionIsOutsideDeclaredFrameAndNotRequiredToBeZero() {
        val short = legacyShapedDeviceInfo(deviceId = EquipmentDeviceIds.FITNESS_BIKE)
        val padded = short.copyOf(64)
        for (i in 29 until 64) padded[i] = 0xA5.toByte()
        val summary = FrameDiagnostics.summarize(
            padded,
            EquipmentDevice.FITNESS_BIKE,
            EquipmentCommand.DEVICE_INFO,
        )
        assertIs<FrameParseResult.Accepted>(summary.parseResult)
        assertEquals(35, summary.trailingPaddingBytes)
        assertFalse(summary.trailingPaddingAllZero!!)
        // Bytes after declared length are ignored by checksum — intentional HID report slack.
        assertEquals(true, summary.checksumValid)
    }

    @Test
    fun responseDeviceOverwriteIsNotAValidMainContract() {
        // Legacy CommandBase.SetResponseBytes assigns Device = bytes[0] and does not
        // reject mismatch. Our codec deliberately keeps strict matching for MAIN TX.
        val frame = legacyShapedDeviceInfo(deviceId = EquipmentDeviceIds.FITNESS_BIKE)
        assertEquals(
            FrameRejection.DEVICE_MISMATCH,
            assertIs<FrameParseResult.Rejected>(
                EquipmentFrameCodec.parseResponse(frame, EquipmentDevice.MAIN, EquipmentCommand.DEVICE_INFO),
            ).rejection,
        )
    }

    private fun legacyShapedDeviceInfo(
        deviceId: Int,
        softwareVersion: Int = 86,
        hardwareVersion: Int = 1,
        serial: Long = 0x0A0B0C0DL,
        manufacturer: Int = 1,
        sectionCount: Int = 15,
    ): ByteArray {
        // Legacy DeviceInfoCmd.SetResponseBytes layout after 4-byte header:
        // sw u8, hw u8, serial u32 LE, manufacturer u16 LE, sections u8, then [sections] mask bytes.
        require(sectionCount in 0..60)
        val dataLen = 1 + 1 + 4 + 2 + 1 + sectionCount
        val length = EquipmentFrameCodec.RESPONSE_HEADER_LENGTH + dataLen + 1
        val frame = ByteArray(length)
        frame[0] = deviceId.toByte()
        frame[1] = length.toByte()
        frame[2] = EquipmentCommand.DEVICE_INFO.id.toByte()
        frame[3] = EquipmentStatus.DONE.code!!.toByte()
        var i = 4
        frame[i++] = softwareVersion.toByte()
        frame[i++] = hardwareVersion.toByte()
        frame[i++] = (serial and 0xFF).toByte()
        frame[i++] = ((serial ushr 8) and 0xFF).toByte()
        frame[i++] = ((serial ushr 16) and 0xFF).toByte()
        frame[i++] = ((serial ushr 24) and 0xFF).toByte()
        frame[i++] = (manufacturer and 0xFF).toByte()
        frame[i++] = ((manufacturer ushr 8) and 0xFF).toByte()
        frame[i++] = sectionCount.toByte()
        repeat(sectionCount) { frame[i++] = 0x01 }
        frame[length - 1] = EquipmentFrameCodec.checksum(frame, length).toByte()
        return frame
    }
}
