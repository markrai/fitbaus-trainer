// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import android.content.Context
import com.fitbaus.arcade.ArcadeTrackerSettings

internal interface ArcadeConfigurationPersistence {
    fun readString(key: String): String?
    fun writeString(key: String, value: String)
    fun readBoolean(key: String): Boolean
    fun writeBoolean(key: String, value: Boolean)
}

internal class ArcadeConfiguration(private val persistence: ArcadeConfigurationPersistence) {
    fun settingsFor(game: ArcadeMode): ArcadeTrackerSettings {
        val key = persistence.readString(trackerKey(game))
        return when {
            game == ArcadeMode.Math -> ArcadeTrackerSettings.fingersFromKey(key)
            usesFaceGamePicker(game) -> ArcadeTrackerSettings.faceFromKey(key)
            else -> ArcadeTrackerSettings.fromKey(key)
        }
    }

    fun saveTracker(game: ArcadeMode, settings: ArcadeTrackerSettings) {
        persistence.writeString(trackerKey(game), settings.key)
    }

    fun presetsFor(game: ArcadeMode): List<ArcadeTrackerSettings> = when {
        game == ArcadeMode.Math -> ArcadeTrackerSettings.FINGER_PRESETS
        usesFaceGamePicker(game) -> ArcadeTrackerSettings.FACE_PRESETS
        else -> ArcadeTrackerSettings.PRESETS
    }

    fun usesFaceGamePicker(game: ArcadeMode): Boolean = when (game) {
        ArcadeMode.Flak, ArcadeMode.TrailRide, ArcadeMode.GhoulRun, ArcadeMode.Biketris -> true
        else -> false
    }

    fun diagnosticsOverlay(): Boolean = persistence.readBoolean(OVERLAY_KEY)

    fun saveDiagnosticsOverlay(enabled: Boolean) = persistence.writeBoolean(OVERLAY_KEY, enabled)

    private fun trackerKey(game: ArcadeMode): String = when (game) {
        ArcadeMode.Math -> "math_tracker"
        ArcadeMode.Flak -> "flak_tracker"
        ArcadeMode.TrailRide -> "trail_tracker"
        ArcadeMode.GhoulRun -> "ghoul_tracker"
        ArcadeMode.Biketris -> "biketris_tracker"
        else -> "tracker"
    }

    private companion object {
        const val OVERLAY_KEY = "overlay"
    }
}

internal class AndroidArcadeConfigurationPersistence(context: Context) : ArcadeConfigurationPersistence {
    private val prefs = context.getSharedPreferences("arcade_dev", Context.MODE_PRIVATE)

    override fun readString(key: String): String? = prefs.getString(key, null)

    override fun writeString(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    override fun readBoolean(key: String): Boolean = prefs.getBoolean(key, false)

    override fun writeBoolean(key: String, value: Boolean) {
        prefs.edit().putBoolean(key, value).apply()
    }
}
