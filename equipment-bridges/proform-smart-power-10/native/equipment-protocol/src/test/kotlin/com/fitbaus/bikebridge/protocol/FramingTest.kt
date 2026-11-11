// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FramingTest {
    private val treadmill = EquipmentDevice.of(4)

    private fun rejection(raw: ByteArray, device: EquipmentDevice = EquipmentDevice.MAIN): FrameRejection {
        val result = EquipmentFrameCodec.parseResponse(raw, device, EquipmentCommand.READ_WRITE_DATA)
        return assertIs<FrameParseResult.Rejected>(result).rejection
    }

    @Test
    fun checksumMatchesStrideFixtures() {
        for (fixture in listOf(
            StrideFixtures.workedExampleReadActualKphActualIncline,
            StrideFixtures.treadmillReadActualKphRequest,
            StrideFixtures.treadmillReadActualKphReply,
            StrideFixtures.treadmillSecurityBlock,
            StrideFixtures.prohibitedBrainboardReset,
        )) {
            val b = fixture.bytes()
            assertEquals(b.last().toInt() and 0xFF, EquipmentFrameCodec.checksum(b, b.size), fixture.toString())
        }
    }

    @Test
    fun checksumTruncatesToEightBits() {
        val b = byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0x03, 0x00)
        assertEquals(0x01, EquipmentFrameCodec.checksum(b, 4))
    }

    @Test
    fun encodesStrideRequestFixturesFromSections() {
        val content = ReadWriteDataCodec.content(emptyList(), listOf(16))
        val frame = EquipmentFrameCodec.encodeRequest(treadmill, EquipmentCommand.READ_WRITE_DATA, content)
        assertEquals(hex(StrideFixtures.treadmillReadActualKphRequest.bytes()), hex(frame))

        val example = ReadWriteDataCodec.content(emptyList(), listOf(17, 16))
        assertEquals(
            hex(StrideFixtures.workedExampleReadActualKphActualIncline.bytes()),
            hex(EquipmentFrameCodec.encodeRequest(treadmill, EquipmentCommand.READ_WRITE_DATA, example)),
        )
    }

    @Test
    fun parsesStrideHardwareReply() {
        val result = EquipmentFrameCodec.parseResponse(
            StrideFixtures.treadmillReadActualKphReply.bytes(),
            treadmill,
            EquipmentCommand.READ_WRITE_DATA,
        )
        val frame = assertIs<FrameParseResult.Accepted>(result).frame
        assertEquals(4, frame.deviceId)
        assertEquals(EquipmentCommand.READ_WRITE_DATA, frame.command)
        assertEquals(EquipmentStatus.DONE, frame.status)
        assertEquals("00 00", hex(frame.data()))
    }

    @Test
    fun requestLengthIsBoundedBySixtyFourBytes() {
        val max = EquipmentFrameCodec.encodeRequest(EquipmentDevice.MAIN, EquipmentCommand.READ_WRITE_DATA, ByteArray(60))
        assertEquals(64, max.size)
        assertEquals(64, max[1].toInt() and 0xFF)
        assertFailsWith<IllegalArgumentException> {
            EquipmentFrameCodec.encodeRequest(EquipmentDevice.MAIN, EquipmentCommand.READ_WRITE_DATA, ByteArray(61))
        }
    }

    @Test
    fun rejectsShortPackets() {
        assertEquals(FrameRejection.TRUNCATED, rejection(ByteArray(0)))
        assertEquals(FrameRejection.TRUNCATED, rejection(Fixture.bytes("02 05 02 02")))
    }

    @Test
    fun rejectsOversizedPackets() {
        val raw = ByteArray(65)
        raw[0] = 2
        raw[1] = 5
        assertEquals(FrameRejection.OVERSIZED, rejection(raw))
    }

    @Test
    fun rejectsDeclaredLengthBeyondReceivedBytes() {
        assertEquals(FrameRejection.TRUNCATED, rejection(Fixture.bytes("02 20 02 02 00")))
    }

    @Test
    fun rejectsDeclaredLengthBelowMinimum() {
        assertEquals(FrameRejection.INVALID_DECLARED_LENGTH, rejection(Fixture.bytes("02 04 02 02 0A")))
        assertEquals(FrameRejection.INVALID_DECLARED_LENGTH, rejection(Fixture.bytes("02 00 02 02 0A")))
    }

    @Test
    fun rejectsCorruptedChecksum() {
        val raw = BikeFixtures.readWattsRpmReply.bytes()
        raw[raw.size - 1] = (raw.last() + 1).toByte()
        assertEquals(FrameRejection.CHECKSUM_MISMATCH, rejection(raw))
        val flipped = BikeFixtures.readWattsRpmReply.bytes()
        flipped[4] = (flipped[4].toInt() xor 0x01).toByte()
        assertEquals(FrameRejection.CHECKSUM_MISMATCH, rejection(flipped))
    }

    @Test
    fun rejectsWrongDevice() {
        assertEquals(FrameRejection.DEVICE_MISMATCH, rejection(BikeFixtures.wrongDevice.bytes()))
        assertEquals(FrameRejection.DEVICE_MISMATCH, rejection(StrideFixtures.treadmillReadActualKphReply.bytes()))
    }

    @Test
    fun rejectsWrongCommand() {
        assertEquals(FrameRejection.COMMAND_MISMATCH, rejection(BikeFixtures.wrongCommand.bytes()))
    }

    @Test
    fun acceptsTrailingHidReportPadding() {
        val padded = BikeFixtures.readWattsRpmReply.bytes().copyOf(64)
        val frame = assertIs<FrameParseResult.Accepted>(
            EquipmentFrameCodec.parseResponse(padded, EquipmentDevice.MAIN, EquipmentCommand.READ_WRITE_DATA),
        ).frame
        assertEquals(4, frame.dataLength)
    }

    @Test
    fun interpretsEveryDocumentedStatusByte() {
        val expected = mapOf(
            0 to EquipmentStatus.DEVICE_NOT_SUPPORTED,
            1 to EquipmentStatus.COMMAND_NOT_SUPPORTED,
            2 to EquipmentStatus.DONE,
            3 to EquipmentStatus.IN_PROGRESS,
            4 to EquipmentStatus.FAILED,
            5 to EquipmentStatus.TIME_LEFT,
            6 to EquipmentStatus.UNRECOGNIZED,
            7 to EquipmentStatus.UNKNOWN_FAILURE,
            8 to EquipmentStatus.SECURITY_BLOCK,
            9 to EquipmentStatus.COMMUNICATION_FAILED,
            200 to EquipmentStatus.UNRECOGNIZED,
        )
        for ((code, status) in expected) {
            val raw = IdentityFixtures.frame(0x02, 0x02, code)
            val frame = assertIs<FrameParseResult.Accepted>(
                EquipmentFrameCodec.parseResponse(raw, EquipmentDevice.MAIN, EquipmentCommand.READ_WRITE_DATA),
            ).frame
            assertEquals(status, frame.status, "status byte $code")
            assertEquals(code, frame.statusCode)
        }
    }

    @Test
    fun prohibitedResetFrameIsNotARecognisedResponse() {
        assertEquals(FrameRejection.TRUNCATED, rejection(StrideFixtures.prohibitedBrainboardReset.bytes()))
        assertNull(EquipmentCommand.fromId(9))
    }

    @Test
    fun deviceIdentifiersAreBounded() {
        assertFailsWith<IllegalArgumentException> { EquipmentDevice.of(0) }
        assertFailsWith<IllegalArgumentException> { EquipmentDevice.of(1) }
        assertFailsWith<IllegalArgumentException> { EquipmentDevice.of(256) }
        assertTrue(EquipmentDevice.of(2) === EquipmentDevice.MAIN)
        assertEquals(EquipmentDevice.of(4), treadmill)
    }
}
