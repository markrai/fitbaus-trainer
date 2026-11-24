// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import com.fitbaus.arcade.ArcadeStopReason

internal enum class ModeKind { Dashboard, Game, Media }

internal enum class ArcadeMode(val caption: String, val kind: ModeKind) {
    Dashboard("DASHBOARD", ModeKind.Dashboard),
    Bricks("BRICKS", ModeKind.Game),
    Math("MATH", ModeKind.Game),
    Flak("MAVERICK", ModeKind.Game),
    TrailRide("TRAILS", ModeKind.Game),
    GhoulRun("IT HEARS YOU", ModeKind.Game),
    Biketris("BIKETRIS", ModeKind.Game),
    YouTube("YouTube", ModeKind.Media),
    Books("Books", ModeKind.Media),
    ;

    val isGame: Boolean
        get() = kind == ModeKind.Game

    val isMedia: Boolean
        get() = kind == ModeKind.Media
}

/**
 * Host callbacks for a mode switch. A mode switch only swaps content views and starts or stops the
 * arcade's own camera/clock or the media player. It never touches the bridge service or the USB session.
 */
internal interface ArcadeModeHooks {
    fun showMode(mode: ArcadeMode)
    fun activateArcade(game: ArcadeMode)
    fun deactivateArcade(reason: ArcadeStopReason)
    fun startMedia(mode: ArcadeMode)
    fun stopMedia(reason: ArcadeStopReason)
}

/**
 * Dashboard vs game vs media state. A game is "active" (camera + clock running) only while it is
 * selected and the host activity is resumed. A media mode only starts its own player and never
 * starts the camera or the arcade clock. Switching between games fully stops the previous game's
 * camera pipeline before the next one starts, so only one pipeline ever runs.
 */
internal class ArcadeModeController(private val hooks: ArcadeModeHooks) {
    var mode: ArcadeMode = ArcadeMode.Dashboard
        private set
    var isActive: Boolean = false
        private set
    var isMediaActive: Boolean = false
        private set
    private var resumed = false
    private var destroyed = false

    fun select(target: ArcadeMode) {
        if (destroyed || target == mode) return
        deactivate(ArcadeStopReason.ExitArcade)
        stopMedia(ArcadeStopReason.ExitArcade)
        mode = target
        hooks.showMode(target)
        if (resumed) start()
    }

    fun onHostResume() {
        if (destroyed) return
        resumed = true
        start()
    }

    fun onHostPause() {
        resumed = false
        deactivate(ArcadeStopReason.HostPaused)
        stopMedia(ArcadeStopReason.HostPaused)
    }

    fun onHostDestroy() {
        resumed = false
        deactivate(ArcadeStopReason.HostDestroyed)
        stopMedia(ArcadeStopReason.HostDestroyed)
        destroyed = true
    }

    private fun start() {
        if (mode.isGame) activate()
        if (mode.isMedia) startMedia()
    }

    private fun startMedia() {
        if (isMediaActive) return
        isMediaActive = true
        hooks.startMedia(mode)
    }

    private fun stopMedia(reason: ArcadeStopReason) {
        if (!isMediaActive) return
        isMediaActive = false
        hooks.stopMedia(reason)
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
