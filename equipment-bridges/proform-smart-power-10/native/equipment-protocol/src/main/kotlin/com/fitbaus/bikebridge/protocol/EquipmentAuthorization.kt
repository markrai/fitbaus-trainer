// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

public fun interface EquipmentExchange {
    public fun exchange(request: EquipmentRequest): ByteArray?
}

public enum class AuthorizationStep {
    DEVICE_INFO,
    SYSTEM_INFO,
    VERSION_INFO,
    VERIFY_SECURITY,
}

public sealed class IdentityCollectionResult {
    public class NotRequired internal constructor(public val deviceInfo: DeviceInfo) : IdentityCollectionResult()

    public class Complete internal constructor(public val identity: MachineIdentity) : IdentityCollectionResult()

    public class Aborted internal constructor(
        public val step: AuthorizationStep,
        public val reason: IdentityRejection,
        public val detail: String,
    ) : IdentityCollectionResult() {
        override fun toString(): String = "Aborted($step, $reason: $detail)"
    }
}

public sealed class AuthorizationOutcome {
    public class NotRequired internal constructor(public val deviceInfo: DeviceInfo) : AuthorizationOutcome()

    public class Unlocked internal constructor(
        public val identity: MachineIdentity,
        public val unlockKey: Int?,
    ) : AuthorizationOutcome()

    public class Refused internal constructor(
        public val identity: MachineIdentity,
        public val outcome: VerifySecurityOutcome,
    ) : AuthorizationOutcome() {
        override fun toString(): String = "Refused($outcome)"
    }

    public class Aborted internal constructor(
        public val step: AuthorizationStep,
        public val reason: IdentityRejection,
        public val detail: String,
    ) : AuthorizationOutcome() {
        override fun toString(): String = "Aborted($step, $reason: $detail)"
    }
}

/**
 * Identity reads and VerifySecurity may target different devices.
 *
 * Legacy `EquipmentConsole.Init`/`Unlock` collect SystemInfo and VersionInfo
 * from MAIN, then send VerifySecurity to the adopted PrimaryDevice. Serial
 * comes from the already-parsed DeviceInfo (MAIN bootstrap / PrimaryDevice
 * object), not from a second SystemInfo on the bike address.
 */
public class EquipmentAuthorizationSequence(
    private val exchange: EquipmentExchange,
    private val identityDevice: EquipmentDevice = EquipmentDevice.MAIN,
    private val verifyDevice: EquipmentDevice = identityDevice,
) {
    public fun run(): AuthorizationOutcome {
        val deviceRequest = EquipmentRequests.deviceInfo(identityDevice)
        val deviceInfo = when (val r = deviceRequest.parse(exchange.exchange(deviceRequest))) {
            is IdentityResult.Rejected -> return AuthorizationOutcome.Aborted(AuthorizationStep.DEVICE_INFO, r.reason, r.detail)
            is IdentityResult.Parsed -> r.value
        }
        return continueAfterDeviceInfo(deviceInfo)
    }

    /**
     * Resume unlock after DeviceInfo is already parsed (MAIN bootstrap, then
     * confirmed PrimaryDevice). Does not send DeviceInfo again. SystemInfo and
     * VersionInfo still go to [identityDevice] (MAIN).
     */
    public fun continueAfterDeviceInfo(deviceInfo: DeviceInfo): AuthorizationOutcome {
        return when (val collected = collectIdentity(deviceInfo)) {
            is IdentityCollectionResult.NotRequired -> AuthorizationOutcome.NotRequired(collected.deviceInfo)
            is IdentityCollectionResult.Aborted ->
                AuthorizationOutcome.Aborted(collected.step, collected.reason, collected.detail)
            is IdentityCollectionResult.Complete -> verifyCollected(collected.identity)
        }
    }

    public fun collectIdentity(deviceInfo: DeviceInfo): IdentityCollectionResult {
        if (!deviceInfo.requiresUnlock) return IdentityCollectionResult.NotRequired(deviceInfo)

        val systemRequest = EquipmentRequests.systemInfo(identityDevice)
        val systemInfo = when (val r = systemRequest.parse(exchange.exchange(systemRequest))) {
            is IdentityResult.Rejected ->
                return IdentityCollectionResult.Aborted(AuthorizationStep.SYSTEM_INFO, r.reason, r.detail)
            is IdentityResult.Parsed -> r.value
        }

        val versionRequest = EquipmentRequests.versionInfo(identityDevice)
        val versionInfo = when (val r = versionRequest.parse(exchange.exchange(versionRequest))) {
            is IdentityResult.Rejected ->
                return IdentityCollectionResult.Aborted(AuthorizationStep.VERSION_INFO, r.reason, r.detail)
            is IdentityResult.Parsed -> r.value
        }

        return IdentityCollectionResult.Complete(MachineIdentity.of(deviceInfo, systemInfo, versionInfo))
    }

    public fun verifyCollected(identity: MachineIdentity): AuthorizationOutcome {
        val verifyRequest = EquipmentRequests.verifySecurity(identity, verifyDevice)
        return when (val outcome = verifyRequest.classify(exchange.exchange(verifyRequest))) {
            is VerifySecurityOutcome.Unlocked -> AuthorizationOutcome.Unlocked(identity, outcome.unlockKey)
            else -> AuthorizationOutcome.Refused(identity, outcome)
        }
    }
}
