// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import com.fitbaus.arcade.ArcadeStopReason
import com.fitbaus.arcade.ArcadeTrackerSettings
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ArcadeLifecycleTest {
    private class Memory : ArcadeConfigurationPersistence {
        val strings = mutableMapOf<String, String>()
        override fun readString(key: String): String? = strings[key]
        override fun writeString(key: String, value: String) { strings[key] = value }
        override fun readBoolean(key: String): Boolean = false
        override fun writeBoolean(key: String, value: Boolean) = Unit
    }

    private class Effects : ArcadeLifecycleEffects {
        val events = mutableListOf<String>()
        override var cameraSettings = ArcadeTrackerSettings.DEFAULT
            private set
        var cameraRunning = false
            private set
        var clockRunning = false
            private set

        override fun resetDiagnostics() { events += "diagnostics" }
        override fun resetBikeMotion() { events += "motion" }
        override fun refreshController() { events += "refreshController" }
        override fun resetController() { events += "resetController" }
        override fun updateCameraSettings(settings: ArcadeTrackerSettings) {
            cameraSettings = settings
            events += "settings:${settings.key}"
        }
        override fun enableWaveGestures(enabled: Boolean) { events += "wave:$enabled" }
        override fun startCamera() {
            cameraRunning = true
            events += "startCamera"
        }
        override fun stopCamera(reason: ArcadeStopReason) {
            cameraRunning = false
            events += "stopCamera:$reason"
        }
        override fun startClock() {
            clockRunning = true
            events += "startClock"
        }
        override fun stopClock() {
            clockRunning = false
            events += "stopClock"
        }
        override fun pauseGames() { events += "pauseGames" }
        override fun setBricksFaceControl(enabled: Boolean) { events += "bricksFace:$enabled" }
    }

    private val memory = Memory()
    private val configuration = ArcadeConfiguration(memory)
    private val effects = Effects()
    private val lifecycle = ArcadeLifecycle(configuration, effects)

    @Test
    fun activationLoadsSavedSettingsAndStartsCameraBeforeClockForEveryGame() {
        for (game in ArcadeMode.entries.filter { it.isGame }) {
            val settings = configuration.presetsFor(game).last()
            configuration.saveTracker(game, settings)
            effects.events.clear()
            lifecycle.activate(game)
            assertEquals(listOf("diagnostics", "motion", "refreshController", "resetController",
                "settings:${settings.key}", "wave:${game == ArcadeMode.Biketris}", "startCamera", "startClock"),
                effects.events, game.name)
            lifecycle.deactivate(ArcadeStopReason.ExitArcade)
        }
    }

    @Test
    fun deactivationStopsClockBeforeCameraAndPausesGamesForEveryReason() {
        for (reason in ArcadeStopReason.entries) {
            lifecycle.activate(ArcadeMode.Biketris)
            effects.events.clear()
            lifecycle.deactivate(reason)
            assertEquals(listOf("resetController", "stopClock", "stopCamera:$reason", "pauseGames"), effects.events)
            assertFalse(effects.cameraRunning)
            assertFalse(effects.clockRunning)
        }
    }

    @Test
    fun editingAnotherGamePersistsOnlyAndUpdatesBricksFaceControlWhenApplicable() {
        lifecycle.activate(ArcadeMode.Biketris)
        val current = effects.cameraSettings
        effects.events.clear()
        val next = ArcadeTrackerSettings.FACE_PRESETS.last()
        lifecycle.applyTrackerSettings(ArcadeMode.Flak, ArcadeMode.Biketris, true, next)
        assertEquals(emptyList<String>(), effects.events)
        assertEquals(next, configuration.settingsFor(ArcadeMode.Flak))
        lifecycle.applyTrackerSettings(ArcadeMode.Bricks, ArcadeMode.Biketris, true, ArcadeTrackerSettings.CLASSICAL)
        assertEquals(listOf("bricksFace:false"), effects.events)
        assertEquals(ArcadeTrackerSettings.CLASSICAL, configuration.settingsFor(ArcadeMode.Bricks))
        assertEquals(current, effects.cameraSettings)
        assertTrue(effects.cameraRunning)
    }

    @Test
    fun activeTrackerChangeRestartsOnlyCameraWithoutRestartingClockOrGame() {
        lifecycle.activate(ArcadeMode.Flak)
        effects.events.clear()
        val next = ArcadeTrackerSettings.FACE_PRESETS.last()
        lifecycle.applyTrackerSettings(ArcadeMode.Flak, ArcadeMode.Flak, true, next)
        assertEquals(listOf("settings:${next.key}", "diagnostics", "stopCamera:HostPaused", "startCamera"), effects.events)
        assertEquals(next, configuration.settingsFor(ArcadeMode.Flak))
        assertTrue(effects.cameraRunning)
        assertTrue(effects.clockRunning)
        effects.events.clear()
        lifecycle.applyTrackerSettings(ArcadeMode.Flak, ArcadeMode.Flak, true, next)
        assertEquals(emptyList<String>(), effects.events)
    }

    @Test
    fun inactiveSelectedTrackerChangeUpdatesSettingsButDoesNotStartCamera() {
        val next = ArcadeTrackerSettings.FACE_PRESETS.last()
        lifecycle.applyTrackerSettings(ArcadeMode.Biketris, ArcadeMode.Biketris, false, next)
        assertEquals(listOf("settings:${next.key}", "diagnostics"), effects.events)
        assertFalse(effects.cameraRunning)
        assertFalse(effects.clockRunning)
        assertEquals(next, configuration.settingsFor(ArcadeMode.Biketris))
    }

    @Test
    fun modeControllerSwitchesWaveModeAndStopsPreviousGameBeforeNextStarts() {
        val hooks = object : ArcadeModeHooks {
            override fun showMode(mode: ArcadeMode) { effects.events += "show:$mode" }
            override fun activateArcade(game: ArcadeMode) = lifecycle.activate(game)
            override fun deactivateArcade(reason: ArcadeStopReason) = lifecycle.deactivate(reason)
            override fun startMedia(mode: ArcadeMode) { effects.events += "media:$mode" }
            override fun stopMedia(reason: ArcadeStopReason) { effects.events += "stopMedia:$reason" }
        }
        val controller = ArcadeModeController(hooks)
        controller.onHostResume()
        controller.select(ArcadeMode.Biketris)
        effects.events.clear()
        controller.select(ArcadeMode.Flak)
        assertEquals(listOf("resetController", "stopClock", "stopCamera:ExitArcade", "pauseGames",
            "show:Flak", "diagnostics", "motion", "refreshController", "resetController",
            "settings:${ArcadeTrackerSettings.FACE_DEFAULT.key}", "wave:false", "startCamera", "startClock"),
            effects.events)
        effects.events.clear()
        controller.select(ArcadeMode.YouTube)
        assertEquals(listOf("resetController", "stopClock", "stopCamera:ExitArcade", "pauseGames",
            "show:YouTube", "media:YouTube"), effects.events)
        assertFalse(effects.cameraRunning)
        assertFalse(effects.clockRunning)
    }
}
