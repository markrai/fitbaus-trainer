// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

public enum class IdentityRejection {
    NO_RESPONSE,
    MALFORMED_FRAME,
    SECURITY_BLOCKED,
    STATUS_NOT_DONE,
    PAYLOAD_TOO_SHORT,
    MISSING_IDENTITY,
    SENTINEL_IDENTITY,
}

public sealed class IdentityResult<out T> {
    public class Parsed<out T> internal constructor(public val value: T) : IdentityResult<T>()

    public class Rejected internal constructor(
        public val reason: IdentityRejection,
        public val detail: String,
    ) : IdentityResult<Nothing>() {
        override fun toString(): String = "Rejected($reason: $detail)"
    }
}

public class DeviceInfo internal constructor(
    public val softwareVersion: Int,
    public val serialNumber: Long,
) {
    /**
     * Protocol-derived eligibility: softwareVersion > 75 selects the documented
     * VerifySecurity sequence. This is not a board-declared unlock field.
     */
    public val requiresUnlock: Boolean get() = EquipmentSecurity.requiresUnlock(softwareVersion)
}

public class SystemInfo internal constructor(
    public val modelNumber: Long,
    public val reportedPartNumber: Long,
) {
    public val partNumber: Long =
        if (reportedPartNumber == KNOWN_MISREPORTED_PART && modelNumber == KNOWN_MISREPORTED_MODEL) {
            CORRECTED_PART
        } else {
            reportedPartNumber
        }

    public companion object {
        public const val KNOWN_MISREPORTED_PART: Long = 370357L
        public const val KNOWN_MISREPORTED_MODEL: Long = 39915L
        public const val CORRECTED_PART: Long = 374677L
    }
}

public class VersionInfo internal constructor(public val masterLibraryVersion: Int)

/**
 * Unlock inputs as Legacy `Unlock` uses them:
 * serial/softwareVersion from DeviceInfo, part/model from SystemInfo, and
 * masterLibraryVersion from VersionInfo. Those replies may come from
 * different device addresses; callers must not mix a PrimaryDevice
 * SystemInfo into this object.
 */
public class MachineIdentity private constructor(
    public val deviceInfo: DeviceInfo,
    public val systemInfo: SystemInfo,
    public val versionInfo: VersionInfo,
) {
    public val serialNumber: Long get() = deviceInfo.serialNumber
    public val partNumber: Long get() = systemInfo.partNumber
    public val modelNumber: Long get() = systemInfo.modelNumber
    public val softwareVersion: Int get() = deviceInfo.softwareVersion
    public val masterLibraryVersion: Int get() = versionInfo.masterLibraryVersion

    public companion object {
        public fun of(deviceInfo: DeviceInfo, systemInfo: SystemInfo, versionInfo: VersionInfo): MachineIdentity =
            MachineIdentity(deviceInfo, systemInfo, versionInfo)
    }
}

public class DeviceInfoRequest private constructor(device: EquipmentDevice) :
    EquipmentRequest(device, EquipmentCommand.DEVICE_INFO) {

    override fun content(): ByteArray = ByteArray(0)

    public fun parse(raw: ByteArray?): IdentityResult<DeviceInfo> =
        IdentityParsing.payload(raw, this, MIN_DATA_LENGTH) { frame ->
            val serial = frame.uint32LittleEndian(SERIAL_OFFSET)
            IdentityParsing.checkIdentityNumber("serial number", serial)
                ?: IdentityResult.Parsed(DeviceInfo(frame.dataByte(SOFTWARE_VERSION_OFFSET), serial))
        }

    internal companion object {
        const val SOFTWARE_VERSION_OFFSET: Int = 0
        const val SERIAL_OFFSET: Int = 2
        const val MIN_DATA_LENGTH: Int = SERIAL_OFFSET + 4

        fun create(device: EquipmentDevice): DeviceInfoRequest = DeviceInfoRequest(device)
    }
}

public class SystemInfoRequest private constructor(device: EquipmentDevice) :
    EquipmentRequest(device, EquipmentCommand.SYSTEM_INFO) {

    override fun content(): ByteArray = byteArrayOf(0, 0)

    public fun parse(raw: ByteArray?): IdentityResult<SystemInfo> =
        IdentityParsing.payload(
            raw,
            this,
            MIN_DATA_LENGTH,
            allowMainToAdoptablePrimary = true,
        ) { frame ->
            val model = frame.uint32LittleEndian(MODEL_OFFSET)
            val part = frame.uint32LittleEndian(PART_OFFSET)
            IdentityParsing.checkIdentityNumber("model number", model)
                ?: IdentityParsing.checkIdentityNumber("part number", part)
                ?: IdentityResult.Parsed(SystemInfo(model, part))
        }

    internal companion object {
        const val MODEL_OFFSET: Int = 3
        const val PART_OFFSET: Int = 7
        const val MIN_DATA_LENGTH: Int = PART_OFFSET + 4

        fun create(device: EquipmentDevice): SystemInfoRequest = SystemInfoRequest(device)
    }
}

public class VersionInfoRequest private constructor(device: EquipmentDevice) :
    EquipmentRequest(device, EquipmentCommand.VERSION_INFO) {

    override fun content(): ByteArray = byteArrayOf(0, 0)

    public fun parse(raw: ByteArray?): IdentityResult<VersionInfo> =
        IdentityParsing.payload(
            raw,
            this,
            MIN_DATA_LENGTH,
            allowMainToAdoptablePrimary = true,
        ) { frame ->
            IdentityResult.Parsed(VersionInfo(frame.dataByte(MASTER_LIBRARY_VERSION_OFFSET)))
        }

    internal companion object {
        const val MASTER_LIBRARY_VERSION_OFFSET: Int = 0
        const val MIN_DATA_LENGTH: Int = 1

        fun create(device: EquipmentDevice): VersionInfoRequest = VersionInfoRequest(device)
    }
}

internal object IdentityParsing {
    private const val UINT32_SENTINEL: Long = 0xFFFFFFFFL

    fun <T> payload(
        raw: ByteArray?,
        request: EquipmentRequest,
        minDataLength: Int,
        allowMainToAdoptablePrimary: Boolean = false,
        decode: (EquipmentResponseFrame) -> IdentityResult<T>,
    ): IdentityResult<T> {
        if (raw == null) return IdentityResult.Rejected(IdentityRejection.NO_RESPONSE, "no response")
        val frame = when (val parsed = parseIdentityFrame(raw, request, allowMainToAdoptablePrimary)) {
            is FrameParseResult.Rejected ->
                return IdentityResult.Rejected(IdentityRejection.MALFORMED_FRAME, "${parsed.rejection}: ${parsed.detail}")
            is FrameParseResult.Accepted -> parsed.frame
        }
        when (frame.status) {
            EquipmentStatus.DONE -> Unit
            EquipmentStatus.SECURITY_BLOCK ->
                return IdentityResult.Rejected(IdentityRejection.SECURITY_BLOCKED, "status ${frame.statusCode}")
            else ->
                return IdentityResult.Rejected(
                    IdentityRejection.STATUS_NOT_DONE,
                    "status ${frame.status}/${frame.statusCode}",
                )
        }
        if (frame.dataLength < minDataLength) {
            return IdentityResult.Rejected(
                IdentityRejection.PAYLOAD_TOO_SHORT,
                "data length ${frame.dataLength} < $minDataLength",
            )
        }
        return decode(frame)
    }

    /**
     * MAIN identity reads on this bike may be answered with the adopted
     * PrimaryDevice address (FitnessBike=7), the same mismatch DeviceInfo
     * bootstrap already accepts. VerifySecurity and field writes stay strict.
     */
    private fun parseIdentityFrame(
        raw: ByteArray,
        request: EquipmentRequest,
        allowMainToAdoptablePrimary: Boolean,
    ): FrameParseResult {
        val parsed = EquipmentFrameCodec.parseResponse(raw, request.device, request.command)
        if (parsed is FrameParseResult.Accepted) return parsed
        if (!allowMainToAdoptablePrimary) return parsed
        if (request.device.id != EquipmentDeviceIds.MAIN) return parsed
        if (parsed !is FrameParseResult.Rejected) return parsed
        if (parsed.rejection != FrameRejection.DEVICE_MISMATCH) return parsed
        if (raw.size < EquipmentFrameCodec.MIN_RESPONSE_LENGTH) return parsed
        val responseDeviceId = raw[0].toInt() and 0xFF
        if (responseDeviceId !in PrimaryDeviceBootstrap.ADOPTABLE_FROM_MAIN) return parsed
        return EquipmentFrameCodec.parseResponse(
            raw,
            EquipmentDevice.of(responseDeviceId),
            request.command,
        )
    }

    fun checkIdentityNumber(name: String, value: Long): IdentityResult.Rejected? = when (value) {
        0L -> IdentityResult.Rejected(IdentityRejection.MISSING_IDENTITY, "$name is zero")
        UINT32_SENTINEL -> IdentityResult.Rejected(IdentityRejection.SENTINEL_IDENTITY, "$name is 0xFFFFFFFF")
        else -> null
    }
}
