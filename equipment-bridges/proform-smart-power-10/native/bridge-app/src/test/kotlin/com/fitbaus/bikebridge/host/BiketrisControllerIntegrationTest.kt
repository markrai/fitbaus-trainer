// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import java.io.File
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BiketrisControllerIntegrationTest {
    private val host = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
    private val controller = File("src/main/kotlin/com/fitbaus/bikebridge/host/controller/GameControllerInput.kt").readText()

    @Test
    @org.junit.jupiter.api.Disabled("Temporary showcase replaces production host wiring; see ShowcaseIsolationTest")
    fun biketrisGetsSelectedControllerInputWithoutWebcamSteering() {
        val tick = host.substringAfter("if (modeController.mode == ArcadeMode.Biketris) {")
            .substringBefore("arcadeContent.playground.controllerAvailable =")
        assertTrue(tick.contains("arcadeContent.biketris.controllerAvailable = gameController.hasController()"))
        assertTrue(tick.contains("val source = arcadeContent.biketris.inputSource"))
        assertTrue(tick.contains("val usingController = source != BiketrisInputSource.Webcam"))
        assertTrue(tick.contains("val controllerOnly = source == BiketrisInputSource.Controller"))
        assertTrue(tick.contains("gameController.takeBiketrisInput()"))
        assertTrue(tick.contains("if (controllerOnly) HandPosition("))
        assertTrue(tick.contains("else handInput.latest(now)"))
        assertTrue(tick.contains("controller = gamepadInput"))
        assertTrue(tick.contains("if (controllerOnly) null else info"))
        assertTrue(host.contains("arcadeContent.biketris.onInputSourceChanged = { gameController.resetTransient() }"))
    }

    @Test
    fun keyAndAxisEventsHaveFourIndependentControllerActions() {
        val keys = host.substringAfter("override fun dispatchKeyEvent(event: KeyEvent)")
            .substringBefore("private fun performMappedGameAction")
        assertTrue(keys.contains("ArcadeMode.Biketris -> arcadeContent.biketris.inputSource != BiketrisInputSource.Webcam"))
        assertTrue(keys.contains("matches && controllerEnabled"))
        assertTrue(keys.contains("mappedAction = action"))
        assertTrue(keys.contains("return true"))
        val motions = host.substringAfter("override fun dispatchGenericMotionEvent(event: MotionEvent)")
            .substringBefore("override fun dispatchTouchEvent")
        assertTrue(motions.contains("ArcadeMode.Biketris"))
        assertTrue(motions.contains("arcadeContent.biketris.inputSource != BiketrisInputSource.Webcam"))
        assertTrue(motions.contains("gameController.handleMotion(event)"))
        assertTrue(controller.contains("\"down\" -> downDown = down"))
        assertTrue(controller.contains("\"rotate\" -> if (down && event.repeatCount == 0) rotationPending = true"))
        assertTrue(controller.contains("rotationPending = false"))
        assertTrue(controller.contains("MotionEvent.AXIS_HAT_Y"))
        assertTrue(controller.contains("ControllerSteering.axis(axisY) > 0.45f"))
    }

    @Test
    @org.junit.jupiter.api.Disabled("Temporary showcase replaces production host wiring; see ShowcaseIsolationTest")
    fun existingBricksInputAndBikeTelemetryRemainSeparate() {
        assertTrue(host.contains("BricksInputRouting.resolve("))
        assertTrue(host.contains("exclusiveHid.sampleBricks(now)"))
        assertTrue(host.contains("controllerOwnership.refreshNow()"))
        assertFalse(controller.contains("requestResistance"))
        assertFalse(controller.contains("NativeBridgeService"))
    }
}
