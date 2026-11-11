// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import kotlin.math.max
import kotlin.math.round

/**
 * Two-byte little-endian resistance codec for Smart Power 10 fields 2 and 18.
 *
 * Independently determined from F2.3 physical alone-reads on this bike
 * (board [maxResistanceLevel]=22):
 * - field 2 raw `5F 03` (u16le 863) reports Legacy resistance 2
 * - field 18 raw `98 08` (u16le 2200) reports level 5
 *
 * Those samples fix the scale `step = 10000 / maxResistanceLevel` and
 * integer rounding on decode. Encoding an integer application level must
 * reproduce the observed field-2 bytes, which requires subtracting
 * `0.1 * step` before truncating to u16le (`encode(2, 22) == 5F 03`).
 *
 * This is the FitnessBike mapping only. Unused catalog device types do not
 * get a decode offset.
 */
public object ResistanceCodec {
    public const val WIRE_WIDTH: Int = 2

    public fun stepSize(maxResistanceLevel: Int): Double {
        require(maxResistanceLevel > 0) { "maxResistanceLevel must be > 0, was $maxResistanceLevel" }
        return 10000.0 / maxResistanceLevel.toDouble()
    }

    /**
     * Decode raw Resistance / ActualResistance field bytes to a rounded level.
     */
    public fun decodeLevel(
        bytes: ByteArray,
        maxResistanceLevel: Int,
    ): Long {
        require(bytes.size == WIRE_WIDTH) {
            "resistance codec expects $WIRE_WIDTH bytes, got ${bytes.size}"
        }
        val raw = ((bytes[0].toInt() and 0xFF) or ((bytes[1].toInt() and 0xFF) shl 8)).toDouble()
        return round(raw / stepSize(maxResistanceLevel)).toLong()
    }

    /**
     * Encode a resistance level for a ReadWriteData write of field 2.
     * Matches F2.3 observed field-2 bytes for integer levels at board max 22.
     */
    public fun encodeLevel(
        level: Double,
        maxResistanceLevel: Int,
    ): ByteArray {
        require(level >= 0.0) { "resistance level must be >= 0, was $level" }
        val step = stepSize(maxResistanceLevel)
        val scaled = (level * step).toInt()
        val adjusted = max(0.0, scaled.toDouble() - step * 0.1).toInt()
        return byteArrayOf(
            (adjusted and 0xFF).toByte(),
            ((adjusted ushr 8) and 0xFF).toByte(),
        )
    }
}
