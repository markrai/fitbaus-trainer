// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.controller

import android.content.SharedPreferences
import android.view.KeyEvent
import com.fitbaus.bikebridge.host.arcade.ArcadeMode

internal data class GameControl(val id: String, val label: String, val defaultKeyCode: Int? = null)

internal object GameControlCatalog {
    private val left = GameControl("left", "Move left", KeyEvent.KEYCODE_DPAD_LEFT)
    private val right = GameControl("right", "Move right", KeyEvent.KEYCODE_DPAD_RIGHT)
    private val down = GameControl("down", "Soft drop", KeyEvent.KEYCODE_DPAD_DOWN)
    private val rotate = GameControl("rotate", "Rotate clockwise", KeyEvent.KEYCODE_BUTTON_A)
    private val reverse = GameControl("reverse", "Reverse direction", KeyEvent.KEYCODE_DPAD_DOWN)
    private val restart = GameControl("restart", "Restart game")

    fun actions(mode: ArcadeMode?): List<GameControl> = when (mode) {
        ArcadeMode.Bricks -> listOf(left, right)
        ArcadeMode.Math -> listOf(restart)
        ArcadeMode.Flak -> listOf(restart)
        ArcadeMode.TrailRide -> listOf(restart)
        ArcadeMode.GhoulRun -> listOf(left, right, reverse, restart)
        ArcadeMode.Biketris -> listOf(left, right, down, rotate)
        else -> emptyList()
    }

    fun fromContext(value: String?): ArcadeMode? {
        val mode = ArcadeMode.entries.firstOrNull { it.name == value }
        return mode?.takeIf { it.isGame }
    }
}

internal class GameControlBindings(private val prefs: SharedPreferences) {
    private fun slot(mode: ArcadeMode, descriptor: String, action: String): String =
        "controller.mapping.v1." + mode.name + "." + descriptor.length + ":" + descriptor + "." + action

    fun keyCode(mode: ArcadeMode, descriptor: String, action: GameControl): Int? {
        val slot = slot(mode, descriptor, action.id)
        if (!prefs.contains(slot)) return action.defaultKeyCode
        val stored = prefs.getInt(slot, -1)
        return stored.takeIf { it >= 0 }
    }

    fun action(mode: ArcadeMode, descriptor: String, keyCode: Int): GameControl? =
        GameControlCatalog.actions(mode).firstOrNull { keyCode(mode, descriptor, it) == keyCode }

    fun assign(mode: ArcadeMode, descriptor: String, actionId: String, keyCode: Int): Boolean {
        if (descriptor.isBlank() || keyCode < 0) return false
        val target = GameControlCatalog.actions(mode).firstOrNull { it.id == actionId } ?: return false
        val editor = prefs.edit()
        for (other in GameControlCatalog.actions(mode)) {
            if (other.id != target.id && keyCode(mode, descriptor, other) == keyCode) {
                editor.putInt(slot(mode, descriptor, other.id), -1)
            }
        }
        editor.putInt(slot(mode, descriptor, target.id), keyCode)
        return editor.commit()
    }

    fun unbind(mode: ArcadeMode, descriptor: String, actionId: String): Boolean {
        if (descriptor.isBlank() || GameControlCatalog.actions(mode).none { it.id == actionId }) return false
        return prefs.edit().putInt(slot(mode, descriptor, actionId), -1).commit()
    }

    fun reset(mode: ArcadeMode, descriptor: String): Boolean {
        if (descriptor.isBlank()) return false
        val editor = prefs.edit()
        for (action in GameControlCatalog.actions(mode)) editor.remove(slot(mode, descriptor, action.id))
        return editor.commit()
    }

    fun describe(mode: ArcadeMode, descriptor: String, action: GameControl): String =
        keyCode(mode, descriptor, action)?.let(KeyEvent::keyCodeToString) ?: "Not assigned"
}
