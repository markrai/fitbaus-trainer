// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.controller

import android.content.SharedPreferences
import android.view.KeyEvent
import com.fitbaus.bikebridge.host.arcade.ArcadeMode
import java.lang.reflect.Proxy
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GameControlBindingsTest {
    @Test
    fun controllerActionsAreGameplayOnlyAndNeverCameraCalibration() {
        assertEquals(listOf("left", "right"), GameControlCatalog.actions(ArcadeMode.Bricks).map { it.id })
        assertFalse(GameControlCatalog.actions(ArcadeMode.Bricks).any { it.id == "restart" })
        assertEquals(listOf("restart"), GameControlCatalog.actions(ArcadeMode.Math).map { it.id })
        assertEquals(listOf("restart"), GameControlCatalog.actions(ArcadeMode.Flak).map { it.id })
        assertEquals(listOf("restart"), GameControlCatalog.actions(ArcadeMode.TrailRide).map { it.id })
        assertEquals(listOf("left", "right", "down", "rotate"), GameControlCatalog.actions(ArcadeMode.Biketris).map { it.id })
        assertTrue(GameControlCatalog.actions(ArcadeMode.Dashboard).isEmpty())
        assertTrue(GameControlCatalog.actions(ArcadeMode.YouTube).isEmpty())
        assertTrue(ArcadeMode.entries.all { mode ->
            GameControlCatalog.actions(mode).none { action ->
                action.id.contains("recenter") || action.id.contains("calibrat")
            }
        })
    }

    @Test
    fun onlyGameContextOpensGameMappingActions() {
        assertNull(GameControlCatalog.fromContext(null))
        assertNull(GameControlCatalog.fromContext("Dashboard"))
        assertNull(GameControlCatalog.fromContext("YouTube"))
        assertNull(GameControlCatalog.fromContext("unknown"))
        assertEquals(ArcadeMode.Flak, GameControlCatalog.fromContext("Flak"))
    }

    @Test
    fun mappingsRemainIsolatedByGameAndPhysicalController() {
        val bindings = GameControlBindings(memoryPreferences())
        val bricksLeft = GameControlCatalog.actions(ArcadeMode.Bricks).first()
        assertEquals(KeyEvent.KEYCODE_DPAD_LEFT, bindings.keyCode(ArcadeMode.Bricks, "pad-one", bricksLeft))
        assertTrue(bindings.assign(ArcadeMode.Bricks, "pad-one", "left", KeyEvent.KEYCODE_BUTTON_A))
        assertEquals("left", bindings.action(ArcadeMode.Bricks, "pad-one", KeyEvent.KEYCODE_BUTTON_A)?.id)
        assertEquals(KeyEvent.KEYCODE_DPAD_LEFT, bindings.keyCode(ArcadeMode.Bricks, "pad-two", bricksLeft))
        assertEquals(KeyEvent.KEYCODE_DPAD_LEFT, bindings.keyCode(ArcadeMode.Biketris, "pad-one", bricksLeft))
        assertTrue(bindings.assign(ArcadeMode.Bricks, "pad-one", "right", KeyEvent.KEYCODE_BUTTON_A))
        assertNull(bindings.keyCode(ArcadeMode.Bricks, "pad-one", bricksLeft))
        assertEquals("right", bindings.action(ArcadeMode.Bricks, "pad-one", KeyEvent.KEYCODE_BUTTON_A)?.id)
        assertFalse(bindings.assign(ArcadeMode.Flak, "pad-one", "recenter", KeyEvent.KEYCODE_BUTTON_B))
        assertFalse(bindings.assign(ArcadeMode.Bricks, "pad-one", "restart", KeyEvent.KEYCODE_BUTTON_START))
        assertNull(bindings.action(ArcadeMode.Bricks, "pad-one", KeyEvent.KEYCODE_BUTTON_START))
        assertTrue(bindings.reset(ArcadeMode.Bricks, "pad-one"))
        assertEquals(KeyEvent.KEYCODE_DPAD_LEFT, bindings.keyCode(ArcadeMode.Bricks, "pad-one", bricksLeft))
    }

    private fun memoryPreferences(): SharedPreferences {
        val stored = mutableMapOf<String, Any>()
        fun newEditor(): SharedPreferences.Editor {
            val changes = mutableMapOf<String, Any?>()
            return Proxy.newProxyInstance(
                SharedPreferences.Editor::class.java.classLoader,
                arrayOf(SharedPreferences.Editor::class.java),
            ) { proxy, method, args ->
                when (method.name) {
                    "putInt", "putString" -> {
                        changes[args!![0] as String] = args[1]
                        proxy
                    }
                    "remove" -> {
                        changes[args!![0] as String] = null
                        proxy
                    }
                    "commit", "apply" -> {
                        changes.forEach { (key, value) ->
                            if (value == null) stored.remove(key) else stored[key] = value
                        }
                        if (method.name == "commit") true else null
                    }
                    else -> error("Unexpected editor method: " + method.name)
                }
            } as SharedPreferences.Editor
        }
        return Proxy.newProxyInstance(
            SharedPreferences::class.java.classLoader,
            arrayOf(SharedPreferences::class.java),
        ) { _, method, args ->
            when (method.name) {
                "contains" -> stored.containsKey(args!![0] as String)
                "getInt" -> stored[args!![0] as String] as? Int ?: args[1] as Int
                "getString" -> stored[args!![0] as String] as? String ?: args[1] as String?
                "edit" -> newEditor()
                else -> error("Unexpected preference method: " + method.name)
            }
        } as SharedPreferences
    }
}
