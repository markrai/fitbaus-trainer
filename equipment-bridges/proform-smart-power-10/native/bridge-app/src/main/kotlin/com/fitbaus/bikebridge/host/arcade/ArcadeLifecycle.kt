// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import com.fitbaus.arcade.ArcadeCameraSession
import com.fitbaus.arcade.ArcadeClock
import com.fitbaus.arcade.ArcadeStopReason
import com.fitbaus.arcade.ArcadeTrackerMode
import com.fitbaus.arcade.ArcadeTrackerSettings
import com.fitbaus.arcade.BikeMotionMonitor
import com.fitbaus.bikebridge.host.controller.GameControllerInput

internal interface ArcadeLifecycleEffects {
    val cameraSettings: ArcadeTrackerSettings
    fun resetDiagnostics()
    fun resetBikeMotion()
    fun refreshController()
    fun resetController()
    fun updateCameraSettings(settings: ArcadeTrackerSettings)
    fun enableWaveGestures(enabled: Boolean)
    fun startCamera()
    fun stopCamera(reason: ArcadeStopReason)
    fun startClock()
    fun stopClock()
    fun pauseGames()
    fun setBricksFaceControl(enabled: Boolean)
}

internal class ArcadeLifecycle(
    private val configuration: ArcadeConfiguration,
    private val effects: ArcadeLifecycleEffects,
) {
    fun activate(game: ArcadeMode) {
        require(game.isGame)
        effects.resetDiagnostics()
        effects.resetBikeMotion()
        effects.refreshController()
        effects.resetController()
        effects.updateCameraSettings(configuration.settingsFor(game))
        effects.enableWaveGestures(game == ArcadeMode.Biketris)
        effects.startCamera()
        effects.startClock()
    }

    fun deactivate(reason: ArcadeStopReason) {
        effects.resetController()
        effects.stopClock()
        effects.stopCamera(reason)
        effects.pauseGames()
    }

    fun applyTrackerSettings(
        game: ArcadeMode,
        selectedMode: ArcadeMode,
        active: Boolean,
        next: ArcadeTrackerSettings,
    ) {
        configuration.saveTracker(game, next)
        if (game == ArcadeMode.Bricks) effects.setBricksFaceControl(next.mode == ArcadeTrackerMode.Face)
        if (game != selectedMode || next == effects.cameraSettings) return
        effects.updateCameraSettings(next)
        effects.resetDiagnostics()
        if (active) {
            effects.stopCamera(ArcadeStopReason.HostPaused)
            effects.startCamera()
        }
    }
}

internal class AndroidArcadeLifecycleEffects(
    private val cameraSession: ArcadeCameraSession,
    private val arcadeClock: ArcadeClock,
    private val gameController: GameControllerInput,
    private val bikeMotion: BikeMotionMonitor,
    private val arcadeContent: ArcadeContent,
    private val clearDiagnostics: () -> Unit,
) : ArcadeLifecycleEffects {
    override val cameraSettings: ArcadeTrackerSettings get() = cameraSession.settings

    override fun resetDiagnostics() = clearDiagnostics()
    override fun resetBikeMotion() = bikeMotion.reset()
    override fun refreshController() = gameController.refresh()
    override fun resetController() = gameController.resetTransient()
    override fun updateCameraSettings(settings: ArcadeTrackerSettings) = cameraSession.updateSettings(settings)
    override fun enableWaveGestures(enabled: Boolean) = cameraSession.enableWaveGestures(enabled)
    override fun startCamera() = cameraSession.start()
    override fun stopCamera(reason: ArcadeStopReason) = cameraSession.stop(reason)
    override fun startClock() = arcadeClock.start()
    override fun stopClock() = arcadeClock.stop()

    override fun pauseGames() {
        arcadeContent.trail.pause()
        arcadeContent.ghoul.pause()
        arcadeContent.biketris.pause()
    }

    override fun setBricksFaceControl(enabled: Boolean) {
        arcadeContent.playground.faceControl = enabled
    }
}
