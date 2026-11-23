// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import java.io.File
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FlakControllerIntegrationTest {
    private val host = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
    private val controller = File("src/main/kotlin/com/fitbaus/bikebridge/host/controller/GameControllerInput.kt").readText()

    @Test
    fun flakReceivesOnlyTheSelectedControllerWithoutWebcamTracking() {
        val tick = host.substringAfter("if (modeController.mode == ArcadeMode.Flak) {")
            .substringBefore("if (modeController.mode == ArcadeMode.TrailRide) {")
        assertTrue(tick.contains("gameController.refresh()"))
        assertTrue(tick.contains("arcadeContent.flak.controllerAvailable = gameController.hasController()"))
        assertTrue(tick.contains("val controllerOnly = arcadeContent.flak.inputSource == FlakInputSource.Controller"))
        assertTrue(tick.contains("if (controllerOnly) HandPosition("))
        assertTrue(tick.contains("else handInput.latest(now)"))
        assertTrue(tick.contains("cameraInfo = if (controllerOnly) null else info"))
        assertTrue(tick.contains("controller = if (controllerOnly) gameController.takeFlakInput() else null"))
        assertTrue(host.contains("arcadeContent.flak.onInputSourceChanged = { gameController.resetTransient() }"))
    }

    @Test
    fun flakControllerKeysAndMotionAreGatedByItsOwnMode() {
        val keys = host.substringAfter("override fun dispatchKeyEvent(event: KeyEvent)")
            .substringBefore("private fun performMappedGameAction")
        assertTrue(keys.contains("ArcadeMode.Flak -> arcadeContent.flak.inputSource == FlakInputSource.Controller"))
        assertTrue(keys.contains("mode == ArcadeMode.GhoulRun || mode == ArcadeMode.Flak"))
        val motion = host.substringAfter("override fun dispatchGenericMotionEvent(event: MotionEvent)")
            .substringBefore("override fun dispatchTouchEvent")
        assertTrue(motion.contains("modeController.mode == ArcadeMode.Flak"))
        assertTrue(motion.contains("arcadeContent.flak.inputSource == FlakInputSource.Controller"))
        assertTrue(motion.contains("gameController.handleMotion(event)"))
        assertTrue(controller.contains("fun takeFlakInput(): FlakControllerInput"))
        assertTrue(controller.contains("\"up\" -> upDown = down"))
        assertTrue(controller.contains("\"down\" -> downDown = down"))
        assertTrue(controller.contains("ControllerSteering.axis(axisX)"))
        assertTrue(controller.contains("ControllerSteering.axis(axisY)"))
        assertFalse(controller.contains("requestResistance"))
    }
}
