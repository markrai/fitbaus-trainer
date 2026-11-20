// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class BricksInputSourceTest {
    @Test
    fun controllerBecomesDefaultWhenConnectedWithoutAnExplicitPreference() {
        assertEquals(BricksInputSource.Webcam, BricksInputSelection.effective(null, false))
        assertEquals(BricksInputSource.Controller, BricksInputSelection.effective(null, true))
        assertEquals(BricksInputSource.Controller, BricksInputSelection.effective("unknown", true))
    }

    @Test
    fun savedWebcamChoiceOverridesTheConnectedController() {
        val saved = BricksInputSource.Webcam.name
        assertEquals(BricksInputSource.Webcam, BricksInputSelection.effective(saved, true))
        assertEquals(BricksInputSource.Webcam, BricksInputSelection.effective(saved, false))
        assertEquals(BricksInputSource.Webcam, BricksInputSelection.effective(saved, true))
    }

    @Test
    fun savedControllerChoiceFallsBackWhenDisconnectedAndRecoversOnReconnect() {
        val saved = BricksInputSource.Controller.name
        assertEquals(BricksInputSource.Controller, BricksInputSelection.effective(saved, true))
        assertEquals(BricksInputSource.Webcam, BricksInputSelection.effective(saved, false))
        assertEquals(BricksInputSource.Controller, BricksInputSelection.effective(saved, true))
    }

    @Test
    fun inputButtonsAppearImmediatelyLeftOfTheExistingSpeedButtons() {
        val speedRight = 800f
        val speedWidth = 44f
        val sourceWidth = 36f
        val gap = 6f
        val firstSpeed = PlaygroundGeometry.speedButtonLeft(BreakoutSpeed.MIN, speedRight, speedWidth, gap)
        val controllerLeft = PlaygroundGeometry.inputSourceButtonLeft(BricksInputSource.Controller, speedRight, speedWidth, sourceWidth, gap)
        val webcamLeft = PlaygroundGeometry.inputSourceButtonLeft(BricksInputSource.Webcam, speedRight, speedWidth, sourceWidth, gap)
        assertEquals(firstSpeed - gap, controllerLeft + sourceWidth)
        assertEquals(controllerLeft - gap, webcamLeft + sourceWidth)
        assertEquals(
            BricksInputSource.Webcam,
            PlaygroundGeometry.inputSourceButtonAt(webcamLeft + sourceWidth / 2f, 14f, speedRight, 2f, speedWidth, sourceWidth, 26f, gap),
        )
        assertEquals(
            BricksInputSource.Controller,
            PlaygroundGeometry.inputSourceButtonAt(controllerLeft + sourceWidth / 2f, 14f, speedRight, 2f, speedWidth, sourceWidth, 26f, gap),
        )
        assertNull(PlaygroundGeometry.inputSourceButtonAt(firstSpeed + speedWidth / 2f, 14f, speedRight, 2f, speedWidth, sourceWidth, 26f, gap))
        assertNull(PlaygroundGeometry.inputSourceButtonAt(webcamLeft + sourceWidth / 2f, 40f, speedRight, 2f, speedWidth, sourceWidth, 26f, gap))
        assertEquals(1, PlaygroundGeometry.speedButtonAt(firstSpeed + speedWidth / 2f, 14f, speedRight, 2f, speedWidth, 26f, gap))
    }

    @Test
    fun canvasSelectionPersistsOnlyAnExplicitUserChoiceAndDoesNotTouchSpeed() {
        val source = File("src/main/kotlin/com/fitbaus/arcade/Playground.kt").readText()
        assertTrue(source.contains("settings.getString(BricksInputSelection.PREF_KEY, null)"))
        assertTrue(source.contains("settings.edit().putString(BricksInputSelection.PREF_KEY, source.name).apply()"))
        assertTrue(source.contains("if (source == BricksInputSource.Controller && !controllerAvailable) return"))
        assertTrue(source.contains("val selected = source == inputSource"))
        assertTrue(source.contains("if (selected) speedSelectedPaint else speedIdlePaint"))
        assertTrue(source.contains("PlaygroundGeometry.inputSourceButtonAt("))
        assertTrue(source.contains("selectSpeed(level)"))
        assertFalse(source.contains("settings.edit().putString(BricksInputSelection.PREF_KEY, inputSource.name)"))
    }
}
