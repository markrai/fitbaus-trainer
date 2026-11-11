// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.policy

import com.fitbaus.bikebridge.protocol.EquipmentDeviceIds
import com.fitbaus.bikebridge.protocol.PrimaryDeviceBootstrap

/**
 * Session-scoped TX authorization. Starts [SessionTransmitAuthorization.MainOnly];
 * may enter provisional awaiting-confirmation, then confirmed PrimaryDevice.
 * Never persists across probe sessions — [resetToMainOnly] on close/reject.
 */
internal class TransmitAllowlist {
    @Volatile
    private var authorization: SessionTransmitAuthorization = SessionTransmitAuthorization.MainOnly

    fun state(): SessionTransmitAuthorization = authorization

    /** Device ids that may appear in TX under the current state (for diagnostics/tests). */
    fun snapshot(): Set<Int> = when (val current = authorization) {
        SessionTransmitAuthorization.MainOnly -> setOf(EquipmentDeviceIds.MAIN)
        is SessionTransmitAuthorization.AwaitingConfirmation -> setOf(current.candidateDeviceId)
        is SessionTransmitAuthorization.Confirmed -> setOf(current.primaryDeviceId)
    }

    fun resetToMainOnly() {
        authorization = SessionTransmitAuthorization.MainOnly
    }

    /**
     * After a valid MAIN DeviceInfo bootstrap observation, permit only
     * DeviceInfo to [candidateDeviceId] until [confirmSessionPrimary].
     */
    fun beginAwaitingConfirmation(candidateDeviceId: Int) {
        require(
            candidateDeviceId == EquipmentDeviceIds.MAIN ||
                candidateDeviceId in PrimaryDeviceBootstrap.ADOPTABLE_FROM_MAIN,
        ) {
            "device $candidateDeviceId is not permitted as PrimaryDevice candidate"
        }
        authorization = SessionTransmitAuthorization.AwaitingConfirmation(candidateDeviceId)
    }

    /**
     * Widen to the full approved read-only command set for the confirmed
     * PrimaryDevice. Requires a matching provisional candidate.
     */
    fun confirmSessionPrimary(deviceId: Int) {
        val current = authorization
        require(current is SessionTransmitAuthorization.AwaitingConfirmation) {
            "confirmSessionPrimary requires AWAITING_CONFIRMATION; was $current"
        }
        require(current.candidateDeviceId == deviceId) {
            "confirm device $deviceId does not match awaiting candidate ${current.candidateDeviceId}"
        }
        authorization = SessionTransmitAuthorization.Confirmed(deviceId)
    }

    fun permitVerifySecurity() {
        val current = authorization
        require(current is SessionTransmitAuthorization.Confirmed) {
            "permitVerifySecurity requires CONFIRMED; was $current"
        }
        authorization = current.copy(allowVerifySecurity = true)
    }

    fun revokeVerifySecurity() {
        val current = authorization
        if (current is SessionTransmitAuthorization.Confirmed) {
            authorization = current.copy(allowVerifySecurity = false)
        }
    }

    fun permitResistanceWrite() {
        val current = authorization
        require(current is SessionTransmitAuthorization.Confirmed) {
            "permitResistanceWrite requires CONFIRMED; was $current"
        }
        authorization = current.copy(allowResistanceWrite = true)
    }

    fun revokeResistanceWrite() {
        val current = authorization
        if (current is SessionTransmitAuthorization.Confirmed) {
            authorization = current.copy(allowResistanceWrite = false)
        }
    }

    fun permitIdleModeLockout() {
        val current = authorization
        require(current is SessionTransmitAuthorization.Confirmed) {
            "permitIdleModeLockout requires CONFIRMED; was $current"
        }
        authorization = current.copy(allowIdleModeLockout = true)
    }

    fun revokeIdleModeLockout() {
        val current = authorization
        if (current is SessionTransmitAuthorization.Confirmed) {
            authorization = current.copy(allowIdleModeLockout = false)
        }
    }
}
