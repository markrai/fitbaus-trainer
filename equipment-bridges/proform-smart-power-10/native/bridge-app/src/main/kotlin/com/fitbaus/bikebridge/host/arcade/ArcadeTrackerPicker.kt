// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import android.app.AlertDialog
import android.content.Context
import com.fitbaus.arcade.ArcadeTrackerSettings

internal class ArcadeTrackerPicker(
    private val context: Context,
    private val configuration: ArcadeConfiguration,
    private val arcadeContent: ArcadeContent,
    private val applyTrackerSettings: (ArcadeMode, ArcadeTrackerSettings) -> Unit,
    private val setDiagnosticsOverlay: (Boolean) -> Unit,
) {
    private fun faceGameOptions(game: ArcadeMode): List<String> = when (game) {
        ArcadeMode.TrailRide -> arcadeContent.trail.developerOptions()
        ArcadeMode.GhoulRun -> arcadeContent.ghoul.developerOptions()
        ArcadeMode.Biketris -> arcadeContent.biketris.developerOptions()
        else -> arcadeContent.flak.developerOptions()
    }

    private fun selectFaceGameOption(game: ArcadeMode, option: Int) {
        when (game) {
            ArcadeMode.TrailRide -> arcadeContent.trail.selectDeveloperOption(option)
            ArcadeMode.GhoulRun -> arcadeContent.ghoul.selectDeveloperOption(option)
            ArcadeMode.Biketris -> arcadeContent.biketris.selectDeveloperOption(option)
            else -> arcadeContent.flak.selectDeveloperOption(option)
        }
    }

    private fun showFaceGamePicker(game: ArcadeMode) {
        val presets = configuration.presetsFor(game)
        val options = faceGameOptions(game)
        val overlay = arcadeContent.playground.diagnosticsOverlay
        val current = presets.indexOf(configuration.settingsFor(game))
        val labels = presets.map { (if (it == presets.getOrNull(current)) "[x] " else "[ ] ") + it.label } + options +
            (if (overlay) "Diagnostics overlay: ON (tap to hide)" else "Diagnostics overlay: OFF (tap to show)")
        AlertDialog.Builder(context)
            .setTitle("${game.caption} (developer)")
            .setItems(labels.toTypedArray()) { dialog, which ->
                dialog.dismiss()
                when {
                    which < presets.size -> applyTrackerSettings(game, presets[which])
                    which < presets.size + options.size -> {
                        selectFaceGameOption(game, which - presets.size)
                        showFaceGamePicker(game)
                    }
                    else -> setDiagnosticsOverlay(!overlay)
                }
            }
            .setNegativeButton("Close", null)
            .show()
    }

    fun show(game: ArcadeMode) {
        if (!game.isGame) return
        if (configuration.usesFaceGamePicker(game)) {
            showFaceGamePicker(game)
            return
        }
        val presets = configuration.presetsFor(game)
        val current = presets.indexOf(configuration.settingsFor(game)).coerceAtLeast(0)
        val overlay = arcadeContent.playground.diagnosticsOverlay
        val labels = presets.map { it.label } + (if (overlay) "Diagnostics overlay: ON (tap to hide)" else "Diagnostics overlay: OFF (tap to show)")
        AlertDialog.Builder(context)
            .setTitle("${game.caption} tracker (developer)")
            .setSingleChoiceItems(labels.toTypedArray(), current) { dialog, which ->
                if (which < presets.size) applyTrackerSettings(game, presets[which]) else setDiagnosticsOverlay(!overlay)
                dialog.dismiss()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

}
