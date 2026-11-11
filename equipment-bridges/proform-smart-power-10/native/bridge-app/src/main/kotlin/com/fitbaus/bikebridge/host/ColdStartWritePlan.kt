// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

/**
 * Differential cold-start write plans.
 *
 * Production identity uses [AuthOnly]: DeviceInfo confirm, MAIN identity
 * collection, one VerifySecurity on the confirmed primary, then telemetry.
 * Staging `unlockQualification=off` keeps [WarmState] (no VerifySecurity) as
 * the rollback APK. [AuthPlusIdleLockout] remains a staging-only experiment.
 * None of these mark the hash as independently established.
 */
internal enum class ColdStartWritePlan {
    WarmState,
    AuthOnly,
    AuthPlusIdleLockout,
    ;

    val allowsVerifySecurity: Boolean get() = this != WarmState

    val writesIdleModeLockout: Boolean get() = this == AuthPlusIdleLockout

    val bootstrapLabel: String
        get() = when (this) {
            WarmState -> HostConstants.INIT_MODE
            AuthOnly -> "cold-start-auth"
            AuthPlusIdleLockout -> "cold-start-auth-lockout"
        }
}
