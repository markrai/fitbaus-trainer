// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import com.fitbaus.arcade.ArcadeTrackerSettings
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ArcadeConfigurationTest {
    private class Memory : ArcadeConfigurationPersistence {
        val strings = mutableMapOf<String, String>()
        val booleans = mutableMapOf<String, Boolean>()

        override fun readString(key: String): String? = strings[key]
        override fun writeString(key: String, value: String) {
            strings[key] = value
        }
        override fun readBoolean(key: String): Boolean = booleans[key] ?: false
        override fun writeBoolean(key: String, value: Boolean) {
            booleans[key] = value
        }
    }

    private val faceGames = listOf(ArcadeMode.Flak, ArcadeMode.TrailRide, ArcadeMode.GhoulRun, ArcadeMode.Biketris)

    @Test
    fun missingAndInvalidSettingsUseExistingGameSpecificDefaults() {
        val memory = Memory()
        val config = ArcadeConfiguration(memory)
        for (value in listOf(null, "unknown", "landmark:99:9")) {
            for (key in listOf("tracker", "math_tracker", "flak_tracker", "trail_tracker", "ghoul_tracker", "biketris_tracker")) {
                if (value == null) memory.strings.remove(key) else memory.strings[key] = value
            }
            assertEquals(ArcadeTrackerSettings.DEFAULT, config.settingsFor(ArcadeMode.Bricks))
            assertEquals(ArcadeTrackerSettings.FINGERS_DEFAULT, config.settingsFor(ArcadeMode.Math))
            for (game in faceGames) assertEquals(ArcadeTrackerSettings.FACE_DEFAULT, config.settingsFor(game), game.name)
        }
    }

    @Test
    fun readsLegacyKeysAndPersistsEachGameIndependently() {
        val memory = Memory()
        val config = ArcadeConfiguration(memory)
        val choices = listOf(
            Triple(ArcadeMode.Bricks, "tracker", ArcadeTrackerSettings.CLASSICAL),
            Triple(ArcadeMode.Math, "math_tracker", ArcadeTrackerSettings.FINGER_PRESETS.last()),
            Triple(ArcadeMode.Flak, "flak_tracker", ArcadeTrackerSettings.FACE_PRESETS.last()),
            Triple(ArcadeMode.TrailRide, "trail_tracker", ArcadeTrackerSettings.FACE_DEFAULT),
            Triple(ArcadeMode.GhoulRun, "ghoul_tracker", ArcadeTrackerSettings.FACE_PRESETS.last()),
            Triple(ArcadeMode.Biketris, "biketris_tracker", ArcadeTrackerSettings.FACE_DEFAULT),
        )
        for ((_, key, setting) in choices) memory.strings[key] = setting.key
        for ((game, _, setting) in choices) assertEquals(setting, config.settingsFor(game), game.name)
        for ((game, key, setting) in choices) {
            val replacement = config.presetsFor(game).first { it != setting }
            val before = memory.strings.toMap()
            config.saveTracker(game, replacement)
            assertEquals(before + (key to replacement.key), memory.strings)
            assertEquals(replacement, ArcadeConfiguration(memory).settingsFor(game))
        }
    }

    @Test
    fun eachMenuExposesOnlyItsExistingPresetFamily() {
        val config = ArcadeConfiguration(Memory())
        assertEquals(ArcadeTrackerSettings.PRESETS, config.presetsFor(ArcadeMode.Bricks))
        assertEquals(ArcadeTrackerSettings.FINGER_PRESETS, config.presetsFor(ArcadeMode.Math))
        for (game in ArcadeMode.entries) {
            assertEquals(game in faceGames, config.usesFaceGamePicker(game), game.name)
            if (game in faceGames) assertEquals(ArcadeTrackerSettings.FACE_PRESETS, config.presetsFor(game))
        }
    }

    @Test
    fun incompatibleStoredPresetFallsBackWithinTheGameFamily() {
        val memory = Memory()
        memory.strings["math_tracker"] = ArcadeTrackerSettings.CLASSICAL.key
        memory.strings["flak_tracker"] = ArcadeTrackerSettings.FINGERS_DEFAULT.key
        val config = ArcadeConfiguration(memory)
        assertEquals(ArcadeTrackerSettings.FINGERS_DEFAULT, config.settingsFor(ArcadeMode.Math))
        assertEquals(ArcadeTrackerSettings.FACE_DEFAULT, config.settingsFor(ArcadeMode.Flak))
    }

    @Test
    fun diagnosticsOverlayIsGlobalAndIndependentOfTrackerSettings() {
        val memory = Memory()
        val config = ArcadeConfiguration(memory)
        assertFalse(config.diagnosticsOverlay())
        config.saveTracker(ArcadeMode.Bricks, ArcadeTrackerSettings.CLASSICAL)
        config.saveDiagnosticsOverlay(true)
        assertEquals(mapOf("overlay" to true), memory.booleans)
        assertTrue(ArcadeConfiguration(memory).diagnosticsOverlay())
        config.saveDiagnosticsOverlay(false)
        assertFalse(ArcadeConfiguration(memory).diagnosticsOverlay())
        assertEquals(mapOf("tracker" to ArcadeTrackerSettings.CLASSICAL.key), memory.strings)
    }
}
