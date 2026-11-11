// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

public object EquipmentFrameCodec {
    public const val MAX_MESSAGE_LENGTH: Int = 64
    public const val REQUEST_OVERHEAD: Int = 4
    public const val RESPONSE_HEADER_LENGTH: Int = 4
    public const val MIN_RESPONSE_LENGTH: Int = RESPONSE_HEADER_LENGTH + 1
    public const val MAX_REQUEST_CONTENT_LENGTH: Int = MAX_MESSAGE_LENGTH - REQUEST_OVERHEAD

    public fun checksum(frame: ByteArray, length: Int): Int {
        require(length in 1..frame.size) { "checksum length $length outside frame of ${frame.size} bytes" }
        var sum = 0
        for (i in 0 until length - 1) {
            sum += frame[i].toInt() and 0xFF
        }
        return sum and 0xFF
    }

    internal fun encodeRequest(device: EquipmentDevice, command: EquipmentCommand, content: ByteArray): ByteArray {
        require(content.size <= MAX_REQUEST_CONTENT_LENGTH) {
            "request content of ${content.size} bytes exceeds $MAX_REQUEST_CONTENT_LENGTH"
        }
        val length = content.size + REQUEST_OVERHEAD
        val frame = ByteArray(length)
        frame[0] = device.id.toByte()
        frame[1] = length.toByte()
        frame[2] = command.id.toByte()
        content.copyInto(frame, 3)
        frame[length - 1] = checksum(frame, length).toByte()
        return frame
    }

    public fun parseResponse(
        raw: ByteArray,
        expectedDevice: EquipmentDevice,
        expectedCommand: EquipmentCommand,
    ): FrameParseResult {
        if (raw.size > MAX_MESSAGE_LENGTH) {
            return FrameParseResult.Rejected(FrameRejection.OVERSIZED, "received ${raw.size} bytes")
        }
        if (raw.size < MIN_RESPONSE_LENGTH) {
            return FrameParseResult.Rejected(FrameRejection.TRUNCATED, "received ${raw.size} bytes")
        }
        val declared = raw[1].toInt() and 0xFF
        if (declared < MIN_RESPONSE_LENGTH) {
            return FrameParseResult.Rejected(FrameRejection.INVALID_DECLARED_LENGTH, "declared length $declared")
        }
        if (declared > raw.size) {
            return FrameParseResult.Rejected(
                FrameRejection.TRUNCATED,
                "declared length $declared exceeds ${raw.size} received bytes",
            )
        }
        val expectedChecksum = checksum(raw, declared)
        val actualChecksum = raw[declared - 1].toInt() and 0xFF
        if (expectedChecksum != actualChecksum) {
            return FrameParseResult.Rejected(
                FrameRejection.CHECKSUM_MISMATCH,
                "expected 0x%02X, received 0x%02X".format(expectedChecksum, actualChecksum),
            )
        }
        val device = raw[0].toInt() and 0xFF
        if (device != expectedDevice.id) {
            return FrameParseResult.Rejected(
                FrameRejection.DEVICE_MISMATCH,
                "expected device ${EquipmentDeviceIds.describe(expectedDevice.id)}, " +
                    "received ${EquipmentDeviceIds.describe(device)}",
            )
        }
        val commandId = raw[2].toInt() and 0xFF
        if (commandId != expectedCommand.id) {
            return FrameParseResult.Rejected(
                FrameRejection.COMMAND_MISMATCH,
                "expected command ${expectedCommand.id}, received $commandId",
            )
        }
        val statusCode = raw[3].toInt() and 0xFF
        val data = raw.copyOfRange(RESPONSE_HEADER_LENGTH, declared - 1)
        return FrameParseResult.Accepted(EquipmentResponseFrame(device, expectedCommand, statusCode, data))
    }
}

public enum class FrameRejection {
    TRUNCATED,
    OVERSIZED,
    INVALID_DECLARED_LENGTH,
    CHECKSUM_MISMATCH,
    DEVICE_MISMATCH,
    COMMAND_MISMATCH,
}

public sealed class FrameParseResult {
    public class Accepted internal constructor(public val frame: EquipmentResponseFrame) : FrameParseResult()

    public class Rejected internal constructor(
        public val rejection: FrameRejection,
        public val detail: String,
    ) : FrameParseResult() {
        override fun toString(): String = "Rejected($rejection: $detail)"
    }
}

public class EquipmentResponseFrame internal constructor(
    public val deviceId: Int,
    public val command: EquipmentCommand,
    public val statusCode: Int,
    private val payload: ByteArray,
) {
    public val status: EquipmentStatus get() = EquipmentStatus.fromCode(statusCode)

    public val dataLength: Int get() = payload.size

    public fun data(): ByteArray = payload.copyOf()

    public fun dataByte(index: Int): Int = payload[index].toInt() and 0xFF

    internal fun uint32LittleEndian(index: Int): Long =
        (dataByte(index).toLong()) or
            (dataByte(index + 1).toLong() shl 8) or
            (dataByte(index + 2).toLong() shl 16) or
            (dataByte(index + 3).toLong() shl 24)
}
