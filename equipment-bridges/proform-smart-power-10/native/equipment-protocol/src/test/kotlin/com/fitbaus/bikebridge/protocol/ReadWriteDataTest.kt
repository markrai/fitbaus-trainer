// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame

class ReadWriteDataTest {
    private val main = EquipmentDevice.MAIN

    private fun read(vararg fields: BikeField) = EquipmentRequests.read(main, fields.toList())

    private fun values(result: ReadWriteDataResult) = assertIs<ReadWriteDataResult.Values>(result).readings

    @Test
    fun emptySectionIsSingleZeroByte() {
        assertEquals("00", hex(ReadWriteDataCodec.section(emptyList())))
    }

    @Test
    fun sectionBitmapMatchesStrideWorkedExample() {
        assertEquals("03 00 00 03", hex(ReadWriteDataCodec.section(listOf(16, 17))))
        assertEquals("03 00 00 03", hex(ReadWriteDataCodec.section(listOf(17, 16))))
    }

    @Test
    fun sectionRejectsDuplicateAndOutOfRangeIds() {
        assertFailsWith<IllegalArgumentException> { ReadWriteDataCodec.section(listOf(3, 3)) }
        assertFailsWith<IllegalArgumentException> { ReadWriteDataCodec.section(listOf(-1)) }
        assertFailsWith<IllegalArgumentException> { ReadWriteDataCodec.section(listOf(256)) }
    }

    @Test
    fun encodesWattsAndRpmRead() {
        assertEquals(hex(BikeFixtures.readWattsRpmRequest.bytes()), hex(read(BikeField.WATTS, BikeField.RPM).encode()))
    }

    @Test
    fun readFieldsAreOrderedAscendingRegardlessOfInput() {
        val request = read(BikeField.RPM, BikeField.WATTS)
        assertEquals(listOf(BikeField.WATTS, BikeField.RPM), request.reads)
        assertEquals(hex(BikeFixtures.readWattsRpmRequest.bytes()), hex(request.encode()))
    }

    @Test
    fun encodesHighFieldIdBitmaps() {
        assertEquals(hex(BikeFixtures.readMaxResistanceLevelRequest.bytes()), hex(read(BikeField.MAX_RESISTANCE_LEVEL).encode()))
        val request = read(
            BikeField.IDLE_MODE_LOCKOUT,
            BikeField.MAX_RESISTANCE_LEVEL,
            BikeField.WORKOUT_MODE,
            BikeField.RPM,
            BikeField.WATTS,
        )
        assertEquals(hex(BikeFixtures.readTelemetryAndStateRequest.bytes()), hex(request.encode()))
        assertEquals(7, request.expectedDataLength)
    }

    @Test
    fun writeSectionPrecedesReadSectionWithValuesAscending() {
        val writeOnly = ReadWriteDataCodec.content(listOf(RawFieldWrite(12, byteArrayOf(1))), emptyList())
        assertEquals("02 00 10 01 00", hex(writeOnly))
        assertEquals(
            "02 09 02 02 00 10 01 00 20",
            hex(EquipmentFrameCodec.encodeRequest(main, EquipmentCommand.READ_WRITE_DATA, writeOnly)),
        )

        val writeAndRead = ReadWriteDataCodec.content(listOf(RawFieldWrite(12, byteArrayOf(1))), listOf(5, 3))
        assertEquals(
            "02 0A 02 02 00 10 01 01 28 4A",
            hex(EquipmentFrameCodec.encodeRequest(main, EquipmentCommand.READ_WRITE_DATA, writeAndRead)),
        )

        val unordered = ReadWriteDataCodec.content(
            listOf(RawFieldWrite(12, byteArrayOf(1)), RawFieldWrite(9, byteArrayOf(5))),
            emptyList(),
        )
        assertEquals("02 00 12 05 01 00", hex(unordered))
    }

    @Test
    fun writeSectionRejectsDuplicatesAndEmptyValues() {
        assertFailsWith<IllegalArgumentException> {
            ReadWriteDataCodec.content(listOf(RawFieldWrite(12, byteArrayOf(1)), RawFieldWrite(12, byteArrayOf(2))), emptyList())
        }
        assertFailsWith<IllegalArgumentException> { RawFieldWrite(12, ByteArray(0)) }
    }

    @Test
    fun publicReadRequestsCarryAnEmptyWriteSection() {
        val encoded = read(BikeField.WATTS).encode()
        assertEquals(0, encoded[3].toInt())
    }

    @Test
    fun rejectsInvalidReadRequests() {
        assertFailsWith<IllegalArgumentException> { EquipmentRequests.read(main, emptyList()) }
        assertFailsWith<IllegalArgumentException> { EquipmentRequests.read(main, listOf(BikeField.WATTS, BikeField.WATTS)) }
        assertFailsWith<IllegalArgumentException> { read(BikeField.RESISTANCE, BikeField.WATTS) }
        assertFailsWith<IllegalArgumentException> { read(BikeField.RESISTANCE, BikeField.ACTUAL_RESISTANCE) }
    }

    @Test
    fun unresolvedFieldMayBeReadAloneForWidthDiscovery() {
        val request = read(BikeField.RESISTANCE)
        assertNull(request.expectedDataLength)
        assertEquals(hex(BikeFixtures.readResistanceRequest.bytes()), hex(request.encode()))

        val one = assertIs<FieldValue.Undecoded>(values(request.decode(BikeFixtures.resistanceOneByte.bytes()))[BikeField.RESISTANCE])
        assertEquals(1, one.width)
        assertEquals("05", hex(one.bytes()))

        val two = assertIs<FieldValue.Undecoded>(values(request.decode(BikeFixtures.resistanceTwoBytes.bytes()))[BikeField.RESISTANCE])
        assertEquals(2, two.width)
    }

    @Test
    fun decodesFieldSizesInAscendingOrder() {
        val readings = values(read(BikeField.RPM, BikeField.WATTS).decode(BikeFixtures.readWattsRpmReply.bytes()))
        assertEquals(listOf(BikeField.WATTS, BikeField.RPM), readings.keys.toList())
        assertEquals(FieldValue.Number(150), readings[BikeField.WATTS])
        assertEquals(FieldValue.Number(72), readings[BikeField.RPM])
    }

    @Test
    fun decodesMixedWidthFields() {
        val request = read(
            BikeField.WATTS,
            BikeField.RPM,
            BikeField.WORKOUT_MODE,
            BikeField.MAX_RESISTANCE_LEVEL,
            BikeField.IDLE_MODE_LOCKOUT,
        )
        val readings = values(request.decode(BikeFixtures.readTelemetryAndStateReply.bytes()))
        assertEquals(FieldValue.Number(200), readings[BikeField.WATTS])
        assertEquals(FieldValue.Number(90), readings[BikeField.RPM])
        assertEquals(WorkoutMode.RUNNING, assertIs<FieldValue.Mode>(readings[BikeField.WORKOUT_MODE]).mode)
        assertEquals(FieldValue.Number(24), readings[BikeField.MAX_RESISTANCE_LEVEL])
        assertEquals(FieldValue.Flag(true), readings[BikeField.IDLE_MODE_LOCKOUT])
    }

    @Test
    fun decodesUnsignedSixteenBitAboveSignBit() {
        val raw = IdentityFixtures.frame(0x02, 0x02, 0x02, 0x00, 0x80, 0x01, 0x00)
        val readings = values(read(BikeField.WATTS, BikeField.RPM).decode(raw))
        assertEquals(FieldValue.Number(32768), readings[BikeField.WATTS])
        assertEquals(FieldValue.Number(1), readings[BikeField.RPM])
    }

    @Test
    fun classifiesSecurityBlock() {
        assertSame(ReadWriteDataResult.SecurityBlocked, read(BikeField.WATTS).decode(BikeFixtures.securityBlock.bytes()))
        val strideRequest = EquipmentRequests.read(EquipmentDevice.of(4), listOf(BikeField.RPM))
        assertSame(ReadWriteDataResult.SecurityBlocked, strideRequest.decode(StrideFixtures.treadmillSecurityBlock.bytes()))
    }

    @Test
    fun rejectsNonDoneStatusEvenWithPlausibleFill() {
        val result = assertIs<ReadWriteDataResult.StatusRejected>(
            read(BikeField.WATTS, BikeField.RPM).decode(BikeFixtures.failedWithFill.bytes()),
        )
        assertEquals(EquipmentStatus.FAILED, result.status)
        assertEquals(4, result.statusCode)
    }

    @Test
    fun reportsSentinelPerField() {
        val readings = values(read(BikeField.WATTS, BikeField.RPM).decode(BikeFixtures.wattsSentinel.bytes()))
        assertSame(FieldValue.Sentinel, readings[BikeField.WATTS])
        assertEquals(FieldValue.Number(72), readings[BikeField.RPM])
    }

    @Test
    fun doneWithoutDataIsMissingFieldData() {
        assertSame(ReadWriteDataResult.FieldDataMissing, read(BikeField.WATTS, BikeField.RPM).decode(BikeFixtures.doneWithoutData.bytes()))
        assertSame(ReadWriteDataResult.FieldDataMissing, read(BikeField.RESISTANCE).decode(BikeFixtures.doneWithoutData.bytes()))
    }

    @Test
    fun rejectsTruncatedAndExcessFieldData() {
        val request = read(BikeField.WATTS, BikeField.RPM)
        val short = assertIs<ReadWriteDataResult.LengthMismatch>(request.decode(BikeFixtures.truncatedFieldData.bytes()))
        assertEquals(4, short.expectedDataLength)
        assertEquals(3, short.actualDataLength)
        val long = assertIs<ReadWriteDataResult.LengthMismatch>(request.decode(BikeFixtures.excessFieldData.bytes()))
        assertEquals(5, long.actualDataLength)
    }

    @Test
    fun reportsMalformedFramesWithReason() {
        val request = read(BikeField.WATTS, BikeField.RPM)
        assertEquals(FrameRejection.DEVICE_MISMATCH, assertIs<ReadWriteDataResult.Malformed>(request.decode(BikeFixtures.wrongDevice.bytes())).rejection)
        assertEquals(FrameRejection.COMMAND_MISMATCH, assertIs<ReadWriteDataResult.Malformed>(request.decode(BikeFixtures.wrongCommand.bytes())).rejection)
        val corrupt = BikeFixtures.readWattsRpmReply.bytes()
        corrupt[5] = 0x01
        assertEquals(FrameRejection.CHECKSUM_MISMATCH, assertIs<ReadWriteDataResult.Malformed>(request.decode(corrupt)).rejection)
        assertEquals(FrameRejection.TRUNCATED, assertIs<ReadWriteDataResult.Malformed>(request.decode(ByteArray(3))).rejection)
    }

    @Test
    fun classifiesInvalidAndSentinelFlags() {
        val request = read(BikeField.IDLE_MODE_LOCKOUT)
        assertIs<FieldValue.InvalidEncoding>(values(request.decode(BikeFixtures.lockoutInvalid.bytes()))[BikeField.IDLE_MODE_LOCKOUT])
        assertSame(FieldValue.Sentinel, values(request.decode(BikeFixtures.lockoutSentinel.bytes()))[BikeField.IDLE_MODE_LOCKOUT])
    }

    @Test
    fun decodesWorkoutModeIncludingSleepAndUnlistedCodes() {
        val request = read(BikeField.WORKOUT_MODE)
        val sleep = assertIs<FieldValue.Mode>(values(request.decode(BikeFixtures.modeSleep.bytes()))[BikeField.WORKOUT_MODE])
        assertEquals(WorkoutMode.SLEEP, sleep.mode)
        val unlisted = assertIs<FieldValue.Mode>(values(request.decode(BikeFixtures.modeUnlisted.bytes()))[BikeField.WORKOUT_MODE])
        assertEquals(50, unlisted.code)
        assertNull(unlisted.mode)
    }
}
