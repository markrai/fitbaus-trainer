// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FrameDiagnosticsTest {
    @Test
    fun distinguishesChecksumFailureFromPostChecksumRejection() {
        val badChecksum = IdentityFixtures.deviceInfo.bytes().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        val checksumFail = FrameDiagnostics.summarize(
            badChecksum,
            EquipmentDevice.MAIN,
            EquipmentCommand.DEVICE_INFO,
        )
        assertEquals(FrameRejection.CHECKSUM_MISMATCH, checksumFail.frameRejection)
        assertTrue(checksumFail.checksumEvaluated)
        assertEquals(false, checksumFail.checksumValid)

        val wrongDevice = BikeFixtures.wrongDevice.bytes()
        val deviceFail = FrameDiagnostics.summarize(
            wrongDevice,
            EquipmentDevice.MAIN,
            EquipmentCommand.READ_WRITE_DATA,
        )
        assertEquals(FrameRejection.DEVICE_MISMATCH, deviceFail.frameRejection)
        assertTrue(deviceFail.checksumEvaluated)
        assertEquals(true, deviceFail.checksumValid)
        assertEquals(4, deviceFail.headerDeviceId)
        assertEquals(2, deviceFail.headerCommandId)
        assertEquals(2, deviceFail.headerStatusCode)
    }

    @Test
    fun reportsTransferVersusDeclaredLengthAndZeroPadding() {
        val short = IdentityFixtures.deviceInfo.bytes()
        val padded = short.copyOf(64)
        val summary = FrameDiagnostics.summarize(
            padded,
            EquipmentDevice.MAIN,
            EquipmentCommand.DEVICE_INFO,
        )
        assertIs<FrameParseResult.Accepted>(summary.parseResult)
        assertEquals(64, summary.transferLength)
        assertEquals(11, summary.declaredLength)
        assertEquals(53, summary.trailingPaddingBytes)
        assertEquals(true, summary.trailingPaddingAllZero)
        assertTrue(summary.checksumEvaluated)
        assertEquals(true, summary.checksumValid)
        assertNull(summary.frameRejection)
    }

    @Test
    fun detectsNonZeroTrailingBytesWithoutWeakeningParse() {
        val short = IdentityFixtures.deviceInfo.bytes()
        val padded = short.copyOf(64)
        padded[63] = 0x7F
        val summary = FrameDiagnostics.summarize(
            padded,
            EquipmentDevice.MAIN,
            EquipmentCommand.DEVICE_INFO,
        )
        // Trailing bytes after declared length are ignored by the codec.
        assertIs<FrameParseResult.Accepted>(summary.parseResult)
        assertEquals(53, summary.trailingPaddingBytes)
        assertEquals(false, summary.trailingPaddingAllZero)
    }

    @Test
    fun truncatedBeforeChecksumIsNotChecksumEvaluated() {
        val summary = FrameDiagnostics.summarize(
            ByteArray(3),
            EquipmentDevice.MAIN,
            EquipmentCommand.DEVICE_INFO,
        )
        assertEquals(FrameRejection.TRUNCATED, summary.frameRejection)
        assertFalse(summary.checksumEvaluated)
        assertNull(summary.checksumValid)
        assertEquals(3, summary.transferLength)
    }

    @Test
    fun neverExposesPayloadBytesInDetailStrings() {
        val summary = FrameDiagnostics.summarize(
            IdentityFixtures.deviceInfo.bytes(),
            EquipmentDevice.MAIN,
            EquipmentCommand.DEVICE_INFO,
        )
        assertNull(summary.frameRejectionDetail)
        // Structural fields only — serial lives in payload and must not appear here.
        assertFalse(summary.toString().contains("123456789"))
    }
}
