// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import com.fitbaus.arcade.ArcadeStopReason

internal enum class ArcadeMode(val caption: String) {
    Dashboard("DASHBOARD"),
    Bricks("BRICKS"),
    Math("MATH"),
    Flak("FLAK RUN"),
    TrailRide("TRAIL RIDE"),
    ;

    val isGame: Boolean
        get() = this != Dashboard
}

/**
 * Host callbacks for a mode switch. A mode switch only swaps content views and starts or stops the
 * arcade's own camera/clock. It never touches the bridge service or the USB session.
 */
internal interface ArcadeModeHooks {
    fun showMode(mode: ArcadeMode)
    fun activateArcade(game: ArcadeMode)
    fun deactivateArcade(reason: ArcadeStopReason)
}

/**
 * Dashboard vs game state. A game is "active" (camera + clock running) only while it is selected
 * and the host activity is resumed. Switching between games fully stops the previous game's
 * camera pipeline before the next one starts, so only one pipeline ever runs.
 */
internal class ArcadeModeController(private val hooks: ArcadeModeHooks) {
    var mode: ArcadeMode = ArcadeMode.Dashboard
        private set
    var isActive: Boolean = false
        private set
    private var resumed = false
    private var destroyed = false

    fun select(target: ArcadeMode) {
        if (destroyed || target == mode) return
        deactivate(ArcadeStopReason.ExitArcade)
        mode = target
        hooks.showMode(target)
        if (target.isGame && resumed) activate()
    }

    fun onHostResume() {
        if (destroyed) return
        resumed = true
        if (mode.isGame) activate()
    }

    fun onHostPause() {
        resumed = false
        deactivate(ArcadeStopReason.HostPaused)
    }

    fun onHostDestroy() {
        resumed = false
        deactivate(ArcadeStopReason.HostDestroyed)
        destroyed = true
    }

    private fun activate() {
        if (isActive) return
        isActive = true
        hooks.activateArcade(mode)
    }

    private fun deactivate(reason: ArcadeStopReason) {
        if (!isActive) return
        isActive = false
        hooks.deactivateArcade(reason)
    }
}
