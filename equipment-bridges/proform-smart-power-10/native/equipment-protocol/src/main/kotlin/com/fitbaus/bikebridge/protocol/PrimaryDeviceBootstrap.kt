// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

/**
 * Explicit bootstrap-only policy for Legacy-compatible PrimaryDevice adoption.
 *
 * The general [EquipmentFrameCodec.parseResponse] decoder remains strict about
 * device-id equality. This policy is the sole place that may adopt
 * [EquipmentDeviceIds.FITNESS_BIKE] when DeviceInfo was requested from MAIN.
 */
public sealed class PrimaryDeviceBootstrapResult {
    public data class Adopted(
        public val requestedDevice: EquipmentDevice,
        public val primaryDevice: EquipmentDevice,
        public val deviceInfo: DeviceInfo,
        public val adoptedFromResponseDeviceMismatch: Boolean,
    ) : PrimaryDeviceBootstrapResult()

    public data class Rejected(
        public val reason: String,
        public val ordinaryDeviceMismatch: Boolean,
        public val detail: String,
    ) : PrimaryDeviceBootstrapResult()
}

public object PrimaryDeviceBootstrap {
    /**
     * Devices that may be adopted when DeviceInfo was requested from MAIN.
     * Narrow: FitnessBike only (Smart Power 10 evidence). SpinBike is catalogued
     * but not auto-adopted without separate hardware proof.
     */
    public val ADOPTABLE_FROM_MAIN: Set<Int> = setOf(EquipmentDeviceIds.FITNESS_BIKE)

    public fun evaluate(
        requestedDevice: EquipmentDevice,
        raw: ByteArray?,
    ): PrimaryDeviceBootstrapResult {
        if (requestedDevice.id != EquipmentDeviceIds.MAIN) {
            return PrimaryDeviceBootstrapResult.Rejected(
                reason = "BOOTSTRAP_REQUEST_NOT_MAIN",
                ordinaryDeviceMismatch = false,
                detail = "bootstrap DeviceInfo must target MAIN; got ${EquipmentDeviceIds.describe(requestedDevice.id)}",
            )
        }
        if (raw == null) {
            return PrimaryDeviceBootstrapResult.Rejected(
                reason = "NO_RESPONSE",
                ordinaryDeviceMismatch = false,
                detail = "no response",
            )
        }

        val mainView = FrameDiagnostics.summarize(raw, EquipmentDevice.MAIN, EquipmentCommand.DEVICE_INFO)
        when (val parsed = mainView.parseResult) {
            is FrameParseResult.Accepted -> {
                return adoptParsed(
                    requestedDevice = requestedDevice,
                    primaryDevice = EquipmentDevice.MAIN,
                    raw = raw,
                    adoptedFromMismatch = false,
                )
            }
            is FrameParseResult.Rejected -> {
                if (parsed.rejection != FrameRejection.DEVICE_MISMATCH) {
                    return PrimaryDeviceBootstrapResult.Rejected(
                        reason = "MALFORMED_FRAME",
                        ordinaryDeviceMismatch = false,
                        detail = "${parsed.rejection}: ${parsed.detail}",
                    )
                }
                val responseDeviceId = mainView.headerDeviceId
                    ?: return PrimaryDeviceBootstrapResult.Rejected(
                        reason = "MALFORMED_FRAME",
                        ordinaryDeviceMismatch = true,
                        detail = parsed.detail,
                    )
                if (responseDeviceId !in ADOPTABLE_FROM_MAIN) {
                    return PrimaryDeviceBootstrapResult.Rejected(
                        reason = "ORDINARY_DEVICE_MISMATCH",
                        ordinaryDeviceMismatch = true,
                        detail = "DeviceInfo response device ${EquipmentDeviceIds.describe(responseDeviceId)} " +
                            "is not an adoptable PrimaryDevice for MAIN bootstrap",
                    )
                }
                if (!mainView.checksumEvaluated || mainView.checksumValid != true) {
                    return PrimaryDeviceBootstrapResult.Rejected(
                        reason = "CHECKSUM_INVALID",
                        ordinaryDeviceMismatch = false,
                        detail = mainView.frameRejectionDetail ?: "checksum not valid",
                    )
                }
                if (mainView.headerCommandId != EquipmentCommand.DEVICE_INFO.id) {
                    return PrimaryDeviceBootstrapResult.Rejected(
                        reason = "COMMAND_MISMATCH",
                        ordinaryDeviceMismatch = false,
                        detail = "expected DeviceInfo, headerCommandId=${mainView.headerCommandId}",
                    )
                }
                val primary = EquipmentDevice.of(responseDeviceId)
                return adoptParsed(
                    requestedDevice = requestedDevice,
                    primaryDevice = primary,
                    raw = raw,
                    adoptedFromMismatch = true,
                )
            }
        }
    }

    /**
     * Confirms an adopted PrimaryDevice with a second DeviceInfo addressed to that
     * device. Distinguishes a live board reply from a single stale IN packet:
     * the confirmation OUT must elicit a Done DeviceInfo from the same device
     * with the same software version and serial (compared in memory only).
     */
    public fun confirm(
        primaryDevice: EquipmentDevice,
        expected: DeviceInfo,
        raw: ByteArray?,
    ): PrimaryDeviceBootstrapResult {
        if (primaryDevice.id !in ADOPTABLE_FROM_MAIN && primaryDevice.id != EquipmentDeviceIds.MAIN) {
            return PrimaryDeviceBootstrapResult.Rejected(
                reason = "CONFIRM_DEVICE_NOT_ALLOWED",
                ordinaryDeviceMismatch = false,
                detail = "cannot confirm ${EquipmentDeviceIds.describe(primaryDevice.id)}",
            )
        }
        if (raw == null) {
            return PrimaryDeviceBootstrapResult.Rejected(
                reason = "NO_RESPONSE",
                ordinaryDeviceMismatch = false,
                detail = "no confirmation response",
            )
        }
        val summary = FrameDiagnostics.summarize(raw, primaryDevice, EquipmentCommand.DEVICE_INFO)
        when (val parsed = summary.parseResult) {
            is FrameParseResult.Rejected ->
                return PrimaryDeviceBootstrapResult.Rejected(
                    reason = "CONFIRM_MALFORMED",
                    ordinaryDeviceMismatch = parsed.rejection == FrameRejection.DEVICE_MISMATCH,
                    detail = "${parsed.rejection}: ${parsed.detail}",
                )
            is FrameParseResult.Accepted -> Unit
        }
        when (val identity = EquipmentRequests.deviceInfo(primaryDevice).parse(raw)) {
            is IdentityResult.Rejected ->
                return PrimaryDeviceBootstrapResult.Rejected(
                    reason = "CONFIRM_IDENTITY_REJECTED",
                    ordinaryDeviceMismatch = false,
                    detail = "${identity.reason}: ${identity.detail}",
                )
            is IdentityResult.Parsed -> {
                if (identity.value.softwareVersion != expected.softwareVersion) {
                    return PrimaryDeviceBootstrapResult.Rejected(
                        reason = "CONFIRM_SOFTWARE_VERSION_MISMATCH",
                        ordinaryDeviceMismatch = false,
                        detail = "confirmation softwareVersion differs from bootstrap adoption",
                    )
                }
                if (identity.value.serialNumber != expected.serialNumber) {
                    return PrimaryDeviceBootstrapResult.Rejected(
                        reason = "CONFIRM_IDENTITY_MISMATCH",
                        ordinaryDeviceMismatch = false,
                        detail = "confirmation identity fields differ from bootstrap adoption",
                    )
                }
                return PrimaryDeviceBootstrapResult.Adopted(
                    requestedDevice = primaryDevice,
                    primaryDevice = primaryDevice,
                    deviceInfo = identity.value,
                    adoptedFromResponseDeviceMismatch = false,
                )
            }
        }
    }

    private fun adoptParsed(
        requestedDevice: EquipmentDevice,
        primaryDevice: EquipmentDevice,
        raw: ByteArray,
        adoptedFromMismatch: Boolean,
    ): PrimaryDeviceBootstrapResult {
        when (val identity = EquipmentRequests.deviceInfo(primaryDevice).parse(raw)) {
            is IdentityResult.Rejected ->
                return PrimaryDeviceBootstrapResult.Rejected(
                    reason = "IDENTITY_REJECTED",
                    ordinaryDeviceMismatch = false,
                    detail = "${identity.reason}: ${identity.detail}",
                )
            is IdentityResult.Parsed ->
                return PrimaryDeviceBootstrapResult.Adopted(
                    requestedDevice = requestedDevice,
                    primaryDevice = primaryDevice,
                    deviceInfo = identity.value,
                    adoptedFromResponseDeviceMismatch = adoptedFromMismatch,
                )
        }
    }
}
