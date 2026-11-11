// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

/**
 * Legacy-equivalent resistance write: ReadWriteData command 2, field 2 only.
 * Does not write WorkoutMode, IdleModeLockout, or VerifySecurity.
 */
public class WriteResistanceRequest private constructor(
    device: EquipmentDevice,
    public val level: Int,
    public val maxResistanceLevel: Int,
    private val encoded: ByteArray,
) : EquipmentRequest(device, EquipmentCommand.READ_WRITE_DATA) {
    override fun content(): ByteArray =
        ReadWriteDataCodec.content(
            listOf(RawFieldWrite(BikeField.RESISTANCE.id, encoded)),
            emptyList(),
        )

    public fun decode(raw: ByteArray): ResistanceWriteResult {
        val frame = when (val parsed = EquipmentFrameCodec.parseResponse(raw, device, command)) {
            is FrameParseResult.Rejected ->
                return ResistanceWriteResult.Malformed(parsed.rejection, parsed.detail)
            is FrameParseResult.Accepted -> parsed.frame
        }
        return when (frame.status) {
            EquipmentStatus.DONE -> ResistanceWriteResult.Accepted(level)
            EquipmentStatus.SECURITY_BLOCK -> ResistanceWriteResult.SecurityBlocked
            else -> ResistanceWriteResult.StatusRejected(frame.status, frame.statusCode)
        }
    }

    internal companion object {
        fun create(device: EquipmentDevice, level: Int, maxResistanceLevel: Int): WriteResistanceRequest {
            ResistanceLimits.validate(level)?.let { throw IllegalArgumentException(it) }
            require(maxResistanceLevel > 0) { "maxResistanceLevel must be > 0, was $maxResistanceLevel" }
            val encoded = ResistanceCodec.encodeLevel(level.toDouble(), maxResistanceLevel)
            val request = WriteResistanceRequest(device, level, maxResistanceLevel, encoded)
            request.encode()
            return request
        }
    }
}

public sealed class ResistanceWriteResult {
    public class Accepted(public val level: Int) : ResistanceWriteResult() {
        override fun toString(): String = "Accepted($level)"
    }

    public object SecurityBlocked : ResistanceWriteResult() {
        override fun toString(): String = "SecurityBlocked"
    }

    public class StatusRejected(
        public val status: EquipmentStatus,
        public val statusCode: Int,
    ) : ResistanceWriteResult() {
        override fun toString(): String = "StatusRejected($status/$statusCode)"
    }

    public class Malformed(
        public val rejection: FrameRejection,
        public val detail: String,
    ) : ResistanceWriteResult() {
        override fun toString(): String = "Malformed($rejection: $detail)"
    }
}
