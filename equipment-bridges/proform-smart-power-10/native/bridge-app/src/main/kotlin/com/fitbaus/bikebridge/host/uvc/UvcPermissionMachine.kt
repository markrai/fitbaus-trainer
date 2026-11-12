// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

/**
 * Cancellation-aware USB permission state for one webcam attachment.
 * Thread-safe; callers must not hold [lock] while performing USB Host I/O.
 */
internal enum class UvcPermissionPhase {
    Unknown,
    Requesting,
    Granted,
    Denied,
}

internal enum class UvcPermissionAction {
    /** Live UsbManager.hasPermission is true — open immediately. */
    OpenNow,
    /** Already denied for this attachment, or still waiting — use Camera1, do not prompt. */
    FallbackNoPrompt,
    /** First need — fire requestPermission, then use Camera1 until a later enter. */
    RequestThenFallback,
}

internal class UvcPermissionMachine {
    private val lock = Any()
    private val phases = HashMap<String, UvcPermissionPhase>()

    fun phase(deviceKey: String): UvcPermissionPhase = synchronized(lock) {
        phases[deviceKey] ?: UvcPermissionPhase.Unknown
    }

    /**
     * @param hasPermission live [android.hardware.usb.UsbManager.hasPermission] result
     */
    fun onOpenAttempt(deviceKey: String, hasPermission: Boolean): UvcPermissionAction = synchronized(lock) {
        if (hasPermission) {
            phases[deviceKey] = UvcPermissionPhase.Granted
            return UvcPermissionAction.OpenNow
        }
        return when (phases[deviceKey] ?: UvcPermissionPhase.Unknown) {
            UvcPermissionPhase.Denied -> UvcPermissionAction.FallbackNoPrompt
            UvcPermissionPhase.Requesting -> UvcPermissionAction.FallbackNoPrompt
            UvcPermissionPhase.Granted -> {
                // Stale grant while hasPermission is false (revoked) — re-request once.
                phases[deviceKey] = UvcPermissionPhase.Requesting
                UvcPermissionAction.RequestThenFallback
            }
            UvcPermissionPhase.Unknown -> {
                phases[deviceKey] = UvcPermissionPhase.Requesting
                UvcPermissionAction.RequestThenFallback
            }
        }
    }

    /**
     * Apply a permission outcome. Always prefer live [hasPermissionNow] over broadcast extras.
     * Late results only update phase; they never open a camera.
     */
    fun onPermissionResult(deviceKey: String, hasPermissionNow: Boolean): UvcPermissionPhase = synchronized(lock) {
        val next = if (hasPermissionNow) UvcPermissionPhase.Granted else UvcPermissionPhase.Denied
        phases[deviceKey] = next
        next
    }

    /** requestPermission threw or could not be issued — leave Unknown so a later enter may retry. */
    fun onRequestFailed(deviceKey: String) = synchronized(lock) {
        if (phases[deviceKey] == UvcPermissionPhase.Requesting) {
            phases.remove(deviceKey)
        }
    }

    /** Detach clears sticky denial so the next plug can prompt again. */
    fun onDetached(deviceKey: String) = synchronized(lock) {
        phases.remove(deviceKey)
    }

    fun clearKeys(predicate: (String) -> Boolean) = synchronized(lock) {
        val remove = phases.keys.filter(predicate)
        for (key in remove) phases.remove(key)
    }

    fun clear() = synchronized(lock) {
        phases.clear()
    }

    /** Test helper: snapshot under lock. */
    internal fun snapshot(): Map<String, UvcPermissionPhase> = synchronized(lock) {
        HashMap(phases)
    }
}
