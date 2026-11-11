// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import java.util.Locale

/**
 * Build gate for Native cold-start VerifySecurity.
 *
 * Production (`PRODUCTION_IDENTITY`) uses [ColdStartWritePlan.AuthOnly]: one
 * VerifySecurity during init when [com.fitbaus.bikebridge.protocol.DeviceInfo.requiresUnlock]
 * is true. That is the sequence qualified on this Smart Power 10. The production
 * path does not mark the hash as independently established.
 *
 * Staging `unlockQualification=off` stays [ColdStartWritePlan.WarmState] so the
 * known-good rollback APK still skips authentication. `-PunlockQualification=auth`
 * / `lockout` remain staging-only Gradle experiments and cannot be combined with
 * `bridgeIdentity=production`. There is no HTTP, Intent, or preference path that
 * can change this at runtime.
 */
internal object UnlockQualification {
    fun plan(
        qualification: String = BuildConfig.UNLOCK_QUALIFICATION,
        productionIdentity: Boolean = BuildConfig.PRODUCTION_IDENTITY,
    ): ColdStartWritePlan =
        when (qualification.lowercase(Locale.US)) {
            "auth" -> ColdStartWritePlan.AuthOnly
            "lockout" -> ColdStartWritePlan.AuthPlusIdleLockout
            else ->
                if (productionIdentity) {
                    ColdStartWritePlan.AuthOnly
                } else {
                    ColdStartWritePlan.WarmState
                }
        }
}
