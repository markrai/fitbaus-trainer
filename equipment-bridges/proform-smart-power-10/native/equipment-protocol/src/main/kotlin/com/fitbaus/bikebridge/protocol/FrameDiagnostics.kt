// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

/**
 * Privacy-safe structural summary of a received USB buffer.
 * Exposes framing / checksum outcomes and header integers only — never payload bytes.
 */
public data class FrameStructureSummary(
    public val transferLength: Int,
    public val declaredLength: Int?,
    public val headerDeviceId: Int?,
    public val headerDeviceName: String?,
    public val headerCommandId: Int?,
    public val headerStatusCode: Int?,
    public val trailingPaddingBytes: Int?,
    public val trailingPaddingAllZero: Boolean?,
    public val checksumEvaluated: Boolean,
    public val checksumValid: Boolean?,
    public val frameRejection: FrameRejection?,
    public val frameRejectionDetail: String?,
    public val parseResult: FrameParseResult,
)

public object FrameDiagnostics {
    public fun summarize(
        raw: ByteArray,
        expectedDevice: EquipmentDevice,
        expectedCommand: EquipmentCommand,
    ): FrameStructureSummary {
        val parseResult = EquipmentFrameCodec.parseResponse(raw, expectedDevice, expectedCommand)
        val declaredLength = if (raw.size >= 2) raw[1].toInt() and 0xFF else null
        val headerDeviceId = if (raw.isNotEmpty()) raw[0].toInt() and 0xFF else null
        val headerCommandId = if (raw.size >= 3) raw[2].toInt() and 0xFF else null
        val headerStatusCode = if (raw.size >= 4) raw[3].toInt() and 0xFF else null

        val padding = paddingMetrics(raw, declaredLength)
        val checksum = checksumMetrics(parseResult)

        return FrameStructureSummary(
            transferLength = raw.size,
            declaredLength = declaredLength,
            headerDeviceId = headerDeviceId,
            headerDeviceName = headerDeviceId?.let { EquipmentDeviceIds.nameOrNull(it) },
            headerCommandId = headerCommandId,
            headerStatusCode = headerStatusCode,
            trailingPaddingBytes = padding.first,
            trailingPaddingAllZero = padding.second,
            checksumEvaluated = checksum.first,
            checksumValid = checksum.second,
            frameRejection = (parseResult as? FrameParseResult.Rejected)?.rejection,
            frameRejectionDetail = (parseResult as? FrameParseResult.Rejected)?.detail,
            parseResult = parseResult,
        )
    }

    private fun paddingMetrics(raw: ByteArray, declaredLength: Int?): Pair<Int?, Boolean?> {
        if (declaredLength == null) return null to null
        if (declaredLength < EquipmentFrameCodec.MIN_RESPONSE_LENGTH) return null to null
        if (declaredLength > raw.size) return null to null
        val trailing = raw.size - declaredLength
        if (trailing == 0) return 0 to true
        var allZero = true
        for (i in declaredLength until raw.size) {
            if (raw[i].toInt() != 0) {
                allZero = false
                break
            }
        }
        return trailing to allZero
    }

    private fun checksumMetrics(parseResult: FrameParseResult): Pair<Boolean, Boolean?> = when (parseResult) {
        is FrameParseResult.Accepted -> true to true
        is FrameParseResult.Rejected -> when (parseResult.rejection) {
            FrameRejection.OVERSIZED,
            FrameRejection.TRUNCATED,
            FrameRejection.INVALID_DECLARED_LENGTH,
            -> false to null
            FrameRejection.CHECKSUM_MISMATCH -> true to false
            FrameRejection.DEVICE_MISMATCH,
            FrameRejection.COMMAND_MISMATCH,
            -> true to true
        }
    }
}
