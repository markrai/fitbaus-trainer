// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

/**
 * Legacy post-init IdleModeLockout write: ReadWriteData command 2, field 95 Flag(true).
 * Used only on the gated Native cold-start path. Not a resistance write.
 */
public class WriteIdleModeLockoutRequest private constructor(
    device: EquipmentDevice,
) : EquipmentRequest(device, EquipmentCommand.READ_WRITE_DATA) {
    override fun content(): ByteArray =
        ReadWriteDataCodec.content(
            listOf(RawFieldWrite(BikeField.IDLE_MODE_LOCKOUT.id, byteArrayOf(0x01))),
            emptyList(),
        )

    public fun decode(raw: ByteArray): IdleModeLockoutWriteResult {
        val frame = when (val parsed = EquipmentFrameCodec.parseResponse(raw, device, command)) {
            is FrameParseResult.Rejected ->
                return IdleModeLockoutWriteResult.Malformed(parsed.rejection, parsed.detail)
            is FrameParseResult.Accepted -> parsed.frame
        }
        return when (frame.status) {
            EquipmentStatus.DONE -> IdleModeLockoutWriteResult.Accepted
            EquipmentStatus.SECURITY_BLOCK -> IdleModeLockoutWriteResult.SecurityBlocked
            else -> IdleModeLockoutWriteResult.StatusRejected(frame.status, frame.statusCode)
        }
    }

    internal companion object {
        fun create(device: EquipmentDevice): WriteIdleModeLockoutRequest {
            val request = WriteIdleModeLockoutRequest(device)
            request.encode()
            return request
        }
    }
}

public sealed class IdleModeLockoutWriteResult {
    public object Accepted : IdleModeLockoutWriteResult() {
        override fun toString(): String = "Accepted"
    }

    public object SecurityBlocked : IdleModeLockoutWriteResult() {
        override fun toString(): String = "SecurityBlocked"
    }

    public class StatusRejected(
        public val status: EquipmentStatus,
        public val statusCode: Int,
    ) : IdleModeLockoutWriteResult() {
        override fun toString(): String = "StatusRejected($status/$statusCode)"
    }

    public class Malformed(
        public val rejection: FrameRejection,
        public val detail: String,
    ) : IdleModeLockoutWriteResult() {
        override fun toString(): String = "Malformed($rejection: $detail)"
    }
}
