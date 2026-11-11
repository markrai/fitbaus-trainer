// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.policy

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
    data class Confirmed(
        val primaryDeviceId: Int,
        val allowVerifySecurity: Boolean = false,
        val allowResistanceWrite: Boolean = false,
        val allowIdleModeLockout: Boolean = false,
    ) : SessionTransmitAuthorization() {
        override fun toString(): String =
            "CONFIRMED(primary=$primaryDeviceId,verify=${if (allowVerifySecurity) 1 else 0}," +
                "resist=${if (allowResistanceWrite) 1 else 0}," +
                "lockout=${if (allowIdleModeLockout) 1 else 0})"
    }
}
