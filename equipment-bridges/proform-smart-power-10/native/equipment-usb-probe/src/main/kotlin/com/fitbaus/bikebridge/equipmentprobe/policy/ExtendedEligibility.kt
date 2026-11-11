// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.policy

import com.fitbaus.bikebridge.equipmentprobe.session.SessionReport
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualificationResult

internal data class ExtendedQualificationState(
    val eligible: Boolean,
    val qualifiedDeviceName: String?,
    val reason: String,
    /**
     * Reserved for a future Extended session that performs its own PrimaryDevice
     * bootstrap. F2.3 never authorizes Extended from a prior Basic PrimaryDevice id.
     */
    val primaryEquipmentDeviceId: Int? = null,
) {
    companion object {
        val NONE: ExtendedQualificationState =
            ExtendedQualificationState(false, null, "extended observation not yet authorized", null)

        const val F2_3_DISABLED_REASON: String =
            "F2.3: Extended Observation disabled until it performs its own PrimaryDevice bootstrap in the new USB session"
    }
}

internal object ExtendedEligibility {
    @Suppress("UNUSED_PARAMETER")
    fun fromBasicReport(
        report: SessionReport,
        currentQualification: UsbQualificationResult,
        primaryEquipmentDeviceId: Int?,
    ): ExtendedQualificationState {
        // Do not carry Basic-session PrimaryDevice into a newly opened USB session.
        // Extended remains disabled for F2.3 regardless of Basic success.
        return ExtendedQualificationState(
            eligible = false,
            qualifiedDeviceName = null,
            reason = ExtendedQualificationState.F2_3_DISABLED_REASON,
            primaryEquipmentDeviceId = null,
        )
    }

    @Suppress("UNUSED_PARAMETER")
    fun stillEligible(
        state: ExtendedQualificationState,
        currentQualification: UsbQualificationResult,
    ): ExtendedQualificationState {
        if (!state.eligible) {
            return ExtendedQualificationState(
                eligible = false,
                qualifiedDeviceName = null,
                reason = ExtendedQualificationState.F2_3_DISABLED_REASON,
                primaryEquipmentDeviceId = null,
            )
        }
        // Defensive: never keep a prior eligible=true across refreshes in F2.3.
        return ExtendedQualificationState(
            eligible = false,
            qualifiedDeviceName = null,
            reason = ExtendedQualificationState.F2_3_DISABLED_REASON,
            primaryEquipmentDeviceId = null,
        )
    }
}
