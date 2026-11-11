// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.policy

/**
 * Session-scoped PrimaryDevice TX authorization lifecycle.
 *
 * Never persists across USB sessions. Provisional
 * [AwaitingConfirmation] must not widen the approved command set.
 */
internal sealed class SessionTransmitAuthorization {
    /** Only DeviceInfo(MAIN) may be transmitted. */
    object MainOnly : SessionTransmitAuthorization() {
        override fun toString(): String = "MAIN_ONLY"
    }

    /**
     * Bootstrap candidate observed; only DeviceInfo(candidate) may be
     * transmitted until confirmation succeeds.
     */
    data class AwaitingConfirmation(val candidateDeviceId: Int) : SessionTransmitAuthorization() {
        override fun toString(): String = "AWAITING_CONFIRMATION(candidate=$candidateDeviceId)"
    }

    /** Confirmed PrimaryDevice; approved read-only commands may target it. */
    data class Confirmed(val primaryDeviceId: Int) : SessionTransmitAuthorization() {
        override fun toString(): String = "CONFIRMED(primary=$primaryDeviceId)"
    }
}
