// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.session

import com.fitbaus.bikebridge.equipmentprobe.ProbeConstants
import com.fitbaus.bikebridge.equipmentprobe.policy.ExtendedEligibility
import com.fitbaus.bikebridge.equipmentprobe.policy.ExtendedQualificationState
import com.fitbaus.bikebridge.equipmentprobe.report.DiagnosticReportWriter
import com.fitbaus.bikebridge.equipmentprobe.usb.OpenResult
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbHostGateway
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualification
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualificationResult
import java.io.File

internal data class PassiveUsbStatus(
    val deviceCount: Int,
    val qualification: UsbQualificationResult,
    val permissionGranted: Boolean?,
)

internal data class SessionReport(
    val phase: ProbePhase,
    val outcome: String,
    val stopKind: StopKind,
    val identityQualified: Boolean,
    val telemetryQualified: Boolean,
    val reportFile: File?,
    val events: List<ProbeEvent>,
    val primaryDeviceId: Int? = null,
)

internal class ProbeSessionRunner(
    private val gateway: UsbHostGateway,
    private val reportDirectory: File,
    private val requestPermission: (deviceName: String) -> Boolean,
) {
    @Volatile
    var extendedQualification: ExtendedQualificationState = ExtendedQualificationState.NONE
        private set

    fun passiveStatus(): PassiveUsbStatus {
        val devices = gateway.listDevices()
        val qualification = UsbQualification.qualify(devices)
        val permission = when (qualification) {
            is UsbQualificationResult.Qualified -> gateway.hasPermission(qualification.device.deviceName)
            is UsbQualificationResult.Rejected -> null
        }
        return PassiveUsbStatus(devices.size, qualification, permission)
    }

    fun refreshExtendedEligibility() {
        extendedQualification = ExtendedEligibility.stillEligible(extendedQualification, passiveStatus().qualification)
    }

    fun clearExtendedEligibility(reason: String = "qualification cleared") {
        extendedQualification = ExtendedQualificationState(false, null, reason)
    }

    fun runBasic(isCancelled: () -> Boolean): SessionReport {
        clearExtendedEligibility("basic probe started")
        val events = ArrayList<ProbeEvent>()
        val status = passiveStatus()
        when (val qualification = status.qualification) {
            is UsbQualificationResult.Rejected -> {
                events += ProbeEvent.UsbRejected(qualification.reason)
                return write(ProbePhase.BASIC, events, qualification.reason, StopKind.QUALIFICATION_FAILED, false, false)
            }
            is UsbQualificationResult.Qualified -> {
                events += ProbeEvent.UsbQualified(qualification.device.deviceName)
            }
        }
        val qualified = status.qualification as UsbQualificationResult.Qualified
        if (!gateway.hasPermission(qualified.device.deviceName)) {
            val granted = requestPermission(qualified.device.deviceName)
            events += ProbeEvent.Permission(granted)
            if (!granted) {
                return write(ProbePhase.BASIC, events, "USB permission denied", StopKind.PERMISSION_DENIED, false, false)
            }
        } else {
            events += ProbeEvent.Permission(true)
        }
        if (!gateway.hasPermission(qualified.device.deviceName)) {
            events += ProbeEvent.Permission(false)
            return write(ProbePhase.BASIC, events, "USB permission not present before open", StopKind.PERMISSION_DENIED, false, false)
        }

        return when (val opened = gateway.openQualified(qualified)) {
            is OpenResult.Failed -> {
                events += ProbeEvent.ClaimResult(false, opened.reason)
                if (opened.requiresForceClaimReview) {
                    events += ProbeEvent.Info(
                        "UNRESOLVED: claimInterface(force=false) failed; force-claim policy requires separate review",
                    )
                }
                write(ProbePhase.BASIC, events, opened.reason, StopKind.CLAIM_FAILED, false, false)
            }
            is OpenResult.Opened -> {
                events += ProbeEvent.ClaimResult(true, "claimInterface(force=false) succeeded")
                var identityQualified = false
                var telemetryQualified = false
                var stopKind = StopKind.NONE
                var summary = "basic diagnostic completed"
                var primaryDeviceId: Int? = null
                try {
                    val outcome = BasicProbeSequence(
                        transport = opened.transport,
                        isCancelled = isCancelled,
                    ).run()
                    events += outcome.events
                    identityQualified = outcome.identityQualified
                    telemetryQualified = outcome.telemetryQualified
                    stopKind = outcome.stopKind
                    summary = outcome.summary
                    primaryDeviceId = outcome.primaryDeviceId
                } finally {
                    opened.transport.close()
                    events += ProbeEvent.Info("USB interface released and connection closed")
                }
                val report = write(
                    ProbePhase.BASIC,
                    events,
                    summary,
                    stopKind,
                    identityQualified,
                    telemetryQualified,
                    primaryDeviceId,
                )
                // F2.3: never authorize Extended from Basic PrimaryDevice; require a future
                // Extended-owned bootstrap before any new-session FitnessBike TX.
                extendedQualification = ExtendedEligibility.fromBasicReport(
                    report,
                    passiveStatus().qualification,
                    primaryDeviceId,
                )
                report
            }
        }
    }

    fun runExtended(isCancelled: () -> Boolean): SessionReport {
        val events = ArrayList<ProbeEvent>()
        refreshExtendedEligibility()
        // F2.3 hard gate: do not open USB or widen the TX allowlist for Extended.
        val reason = if (!extendedQualification.eligible) {
            extendedQualification.reason
        } else {
            ExtendedQualificationState.F2_3_DISABLED_REASON
        }
        clearExtendedEligibility(ExtendedQualificationState.F2_3_DISABLED_REASON)
        events += ProbeEvent.Info("extended refused: $reason")
        return write(
            ProbePhase.EXTENDED,
            events,
            "extended observation not authorized: $reason",
            StopKind.QUALIFICATION_FAILED,
            false,
            false,
        )
    }

    /**
     * F2.4 dynamic observation. Always performs a fresh USB open + PrimaryDevice
     * bootstrap in this session. Does not consume or grant Extended eligibility.
     */
    fun runDynamic(
        isCancelled: () -> Boolean,
        stageCoordinator: StageCoordinator = StageCoordinator(),
        initialStage: String? = null,
        durationMs: Long = ProbeConstants.DYNAMIC_DURATION_MS,
    ): SessionReport {
        clearExtendedEligibility("dynamic observation started")
        val boundedDurationMs = ProbeConstants.clampDynamicDurationMs(durationMs)
        val events = ArrayList<ProbeEvent>()
        events += ProbeEvent.Info(
            "dynamic duration requestMs=$durationMs boundedMs=$boundedDurationMs " +
                "(min=${ProbeConstants.DYNAMIC_DURATION_MS_MIN} max=${ProbeConstants.DYNAMIC_DURATION_MS_MAX}) " +
                "initialStage=${initialStage ?: "none"}",
        )
        val status = passiveStatus()
        when (val qualification = status.qualification) {
            is UsbQualificationResult.Rejected -> {
                events += ProbeEvent.UsbRejected(qualification.reason)
                return write(ProbePhase.DYNAMIC, events, qualification.reason, StopKind.QUALIFICATION_FAILED, false, false)
            }
            is UsbQualificationResult.Qualified -> {
                events += ProbeEvent.UsbQualified(qualification.device.deviceName)
            }
        }
        val qualified = status.qualification as UsbQualificationResult.Qualified
        if (!gateway.hasPermission(qualified.device.deviceName)) {
            val granted = requestPermission(qualified.device.deviceName)
            events += ProbeEvent.Permission(granted)
            if (!granted) {
                return write(ProbePhase.DYNAMIC, events, "USB permission denied", StopKind.PERMISSION_DENIED, false, false)
            }
        } else {
            events += ProbeEvent.Permission(true)
        }
        if (!gateway.hasPermission(qualified.device.deviceName)) {
            events += ProbeEvent.Permission(false)
            return write(
                ProbePhase.DYNAMIC,
                events,
                "USB permission not present before open",
                StopKind.PERMISSION_DENIED,
                false,
                false,
            )
        }

        return when (val opened = gateway.openQualified(qualified)) {
            is OpenResult.Failed -> {
                events += ProbeEvent.ClaimResult(false, opened.reason)
                if (opened.requiresForceClaimReview) {
                    events += ProbeEvent.Info(
                        "UNRESOLVED: claimInterface(force=false) failed; force-claim policy requires separate review",
                    )
                }
                write(ProbePhase.DYNAMIC, events, opened.reason, StopKind.CLAIM_FAILED, false, false)
            }
            is OpenResult.Opened -> {
                events += ProbeEvent.ClaimResult(true, "claimInterface(force=false) succeeded")
                var stopKind = StopKind.NONE
                var summary = "dynamic observation completed"
                var primaryDeviceId: Int? = null
                var telemetryQualified = false
                try {
                    val outcome = DynamicObservationSequence(
                        transport = opened.transport,
                        stageCoordinator = stageCoordinator,
                        initialStage = initialStage,
                        durationMs = boundedDurationMs,
                        isCancelled = isCancelled,
                    ).run()
                    events += outcome.events
                    stopKind = outcome.stopKind
                    summary = outcome.summary
                    primaryDeviceId = outcome.primaryDeviceId
                    telemetryQualified = outcome.sampleCount > 0 && outcome.stopKind == StopKind.NONE
                } finally {
                    opened.transport.close()
                    events += ProbeEvent.Info("USB interface released and connection closed")
                }
                // Never authorize Extended from Dynamic either.
                extendedQualification = ExtendedQualificationState(
                    eligible = false,
                    qualifiedDeviceName = null,
                    reason = ExtendedQualificationState.F2_3_DISABLED_REASON,
                    primaryEquipmentDeviceId = null,
                )
                write(
                    ProbePhase.DYNAMIC,
                    events,
                    summary,
                    stopKind,
                    identityQualified = primaryDeviceId != null,
                    telemetryQualified = telemetryQualified,
                    primaryDeviceId = primaryDeviceId,
                )
            }
        }
    }

    private fun write(
        phase: ProbePhase,
        events: List<ProbeEvent>,
        outcome: String,
        stopKind: StopKind,
        identityQualified: Boolean,
        telemetryQualified: Boolean,
        primaryDeviceId: Int? = null,
    ): SessionReport {
        val file = try {
            DiagnosticReportWriter(reportDirectory).write(phase, events, outcome)
        } catch (_: Exception) {
            null
        }
        return SessionReport(
            phase,
            outcome,
            stopKind,
            identityQualified,
            telemetryQualified,
            file,
            events,
            primaryDeviceId,
        )
    }
}
