// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.session

import com.fitbaus.bikebridge.protocol.BikeField
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentStatus

internal enum class ProbePhase {
    BASIC,
    EXTENDED,
    /** F2.4 bounded read-only dynamic telemetry observation (own PrimaryDevice bootstrap). */
    DYNAMIC,
}

internal sealed class ProbeEvent {
    data class Info(val message: String) : ProbeEvent()
    data class UsbQualified(val deviceName: String) : ProbeEvent()
    data class UsbRejected(val reason: String) : ProbeEvent()
    data class Permission(val granted: Boolean) : ProbeEvent()
    data class ClaimResult(val success: Boolean, val detail: String) : ProbeEvent()
    data class PrimaryDeviceAdopted(
        val requestedDeviceId: Int,
        val primaryDeviceId: Int,
        val primaryDeviceName: String?,
        val adoptedFromResponseDeviceMismatch: Boolean,
        val confirmed: Boolean,
        val softwareVersion: Int,
    ) : ProbeEvent()
    data class RequestSent(
        val command: EquipmentCommand,
        val deviceId: Int,
        val requestBytes: Int,
        val durationMs: Long,
        val sensitive: Boolean,
    ) : ProbeEvent()
    data class ResponseObserved(
        val command: EquipmentCommand,
        val status: EquipmentStatus?,
        val statusCode: Int?,
        /** Actual USB transfer length preserved from bulkTransfer read count. */
        val frameLength: Int,
        val checksumValid: Boolean,
        val parseSummary: String,
        val softwareVersion: Int? = null,
        val identityComponentsPresent: Boolean? = null,
        val telemetryHex: String? = null,
        val durationMs: Long,
        val checksumEvaluated: Boolean = false,
        val declaredLength: Int? = null,
        val frameRejection: String? = null,
        val frameRejectionDetail: String? = null,
        val headerDeviceId: Int? = null,
        val headerDeviceName: String? = null,
        val headerCommandId: Int? = null,
        val headerStatusCode: Int? = null,
        val trailingPaddingBytes: Int? = null,
        val trailingPaddingAllZero: Boolean? = null,
    ) : ProbeEvent()
    data class FieldReading(
        val field: BikeField,
        val summary: String,
        val rawHex: String?,
        /** Monotonic elapsed ms from session start when known (dynamic observation samples). */
        val elapsedMs: Long? = null,
        /** Active operator stage when sample was taken; null if outside a stage. */
        val stage: String? = null,
        /** True during post-START stabilization; excluded from parity. */
        val inStabilize: Boolean = false,
    ) : ProbeEvent()
    data class StageBoundary(
        val kind: StageSignalKind,
        val stage: String,
        val elapsedMs: Long,
    ) : ProbeEvent()
    data class Stopped(val reason: String) : ProbeEvent()
    data class Completed(val outcome: String, val requestsUsed: Int) : ProbeEvent()
    data class TransmitRejected(val reason: String) : ProbeEvent()
}

internal enum class StopKind {
    NONE,
    SECURITY_BLOCK,
    DEVICE_NOT_SUPPORTED,
    TRANSPORT_FAILURE,
    MALFORMED,
    DETACH,
    CANCELLED,
    BUDGET_EXHAUSTED,
    POLICY_REJECT,
    QUALIFICATION_FAILED,
    CLAIM_FAILED,
    PERMISSION_DENIED,
}
