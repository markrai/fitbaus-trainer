// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Fixtures from F2.3 Smart Power 10 physical alone-reads (MaxResistanceLevel=22).
 */
class ResistanceCodecTest {
    @Test
    fun stepSizeUsesBoardMax() {
        assertEquals(10000.0 / 22.0, ResistanceCodec.stepSize(22), 0.0)
        assertEquals(10000.0 / 15.0, ResistanceCodec.stepSize(15), 0.0)
    }

    @Test
    fun f2_3PhysicalResistanceRawDecodesToLegacyObservedLevel() {
        // Report raw=5F 03, Legacy telemetry resistance.value=2 at same rest session family.
        val raw = byteArrayOf(0x5F, 0x03)
        assertEquals(2L, ResistanceCodec.decodeLevel(raw, maxResistanceLevel = 22))
        assertArrayEquals(raw, ResistanceCodec.encodeLevel(2.0, maxResistanceLevel = 22))
    }

    @Test
    fun f2_3PhysicalActualResistanceRawDecodesConsistently() {
        // Report raw=98 08 with MaxResistanceLevel=22 → round(2200 / (10000/22)) = 5.
        val raw = byteArrayOf(0x98.toByte(), 0x08)
        assertEquals(5L, ResistanceCodec.decodeLevel(raw, maxResistanceLevel = 22))
        assertEquals(5L, ResistanceCodec.decodeLevel(ResistanceCodec.encodeLevel(5.0, 22), 22))
    }

    @Test
    fun encodeDecodeRoundTripAcrossApplicationWindowUsingBoardMax() {
        val boardMax = 22
        val appMax = 15
        assertTrue(appMax < boardMax)
        for (level in 1..appMax) {
            val encoded = ResistanceCodec.encodeLevel(level.toDouble(), boardMax)
            assertEquals(2, encoded.size)
            assertEquals(level.toLong(), ResistanceCodec.decodeLevel(encoded, boardMax))
        }
        assertEquals(
            2L,
            ResistanceCodec.decodeLevel(byteArrayOf(0x5F, 0x03), boardMax),
        )
        assertTrue(
            ResistanceCodec.decodeLevel(byteArrayOf(0x5F, 0x03), appMax) != 2L ||
                ResistanceCodec.stepSize(appMax) != ResistanceCodec.stepSize(boardMax),
        )
    }

    @Test
    fun wireWidthIsTwoBytesLittleEndian() {
        assertEquals(2, ResistanceCodec.WIRE_WIDTH)
        val bytes = ResistanceCodec.encodeLevel(1.0, 22)
        val u16 = (bytes[0].toInt() and 0xFF) or ((bytes[1].toInt() and 0xFF) shl 8)
        val step = 10000.0 / 22.0
        val expected = maxOf(0.0, (1.0 * step).toInt().toDouble() - step * 0.1).toInt()
        assertEquals(expected, u16)
        assertEquals(1L, ResistanceCodec.decodeLevel(bytes, 22))
    }
}
