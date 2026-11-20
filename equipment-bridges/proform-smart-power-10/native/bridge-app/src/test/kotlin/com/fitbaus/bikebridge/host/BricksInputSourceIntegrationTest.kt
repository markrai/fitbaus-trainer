// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class BricksInputSourceIntegrationTest {
    private val host = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
    private val gamepad = File("src/main/kotlin/com/fitbaus/bikebridge/host/controller/GameControllerInput.kt").readText()

    @Test
    fun gameActivationStartsTheCameraRegardlessOfControllerAvailability() {
        val activation = host.substringAfter("override fun activateArcade(game: ArcadeMode)")
            .substringBefore("override fun deactivateArcade")
        assertTrue(activation.contains("cameraSession.start()"))
        assertTrue(activation.contains("gameController.refresh()"))
        assertFalse(activation.contains("BricksInputSource.Controller"))
    }

    @Test
    fun bricksUsesOnlyTheExplicitlySelectedSteeringSource() {
        val bricks = host.substringAfter("private fun arcadeTick()")
            .substringBefore("private fun arcadeDiagnosticsText")
        assertTrue(bricks.contains("arcadeContent.playground.controllerAvailable = gameController.hasController() || exclusiveHid.isActive()"))
        assertTrue(bricks.contains("arcadeContent.playground.inputSource != BricksInputSource.Controller"))
        assertTrue(bricks.contains("if (handInput.isTouching()"))
        assertTrue(bricks.contains("exclusiveHid.sampleBricks(now)"))
        assertTrue(bricks.contains("gameController.sample(now)"))
        assertTrue(bricks.contains("val position = controllerPosition ?: handInput.latest(now)"))
        assertTrue(bricks.contains("ArcadeStatusResolver.resolve("))
        assertTrue(gamepad.contains("fun hasController(): Boolean = activeDeviceId >= 0"))
    }

    @Test
    fun webcamSelectionBlocksBricksControllerActionsButStillConsumesDeviceEvents() {
        val keys = host.substringAfter("override fun dispatchKeyEvent(event: KeyEvent)")
            .substringBefore("private fun performMappedGameAction")
        assertTrue(keys.contains("val bricksControllerEnabled = mode != ArcadeMode.Bricks ||"))
        assertTrue(keys.contains("arcadeContent.playground.inputSource == BricksInputSource.Controller"))
        assertTrue(keys.contains("matches && bricksControllerEnabled"))
        assertTrue(keys.contains("steerBricks = modeController.isActive && bricksControllerEnabled"))
        assertTrue(keys.contains("return true"))
        val motion = host.substringAfter("override fun dispatchGenericMotionEvent(event: MotionEvent)")
            .substringBefore("override fun dispatchTouchEvent")
        assertTrue(motion.contains("arcadeContent.playground.inputSource == BricksInputSource.Controller"))
        assertTrue(host.contains("arcadeContent.playground.onInputSourceChanged = { gameController.resetTransient() }"))
    }

    @Test
    fun otherGameRenderersStillUseTheirExistingCameraInput() {
        val tick = host.substringAfter("private fun arcadeTick()")
            .substringBefore("private fun arcadeDiagnosticsText")
        val flak = tick.substringAfter("if (modeController.mode == ArcadeMode.Flak)")
            .substringBefore("if (modeController.mode == ArcadeMode.TrailRide)")
        val trail = tick.substringAfter("if (modeController.mode == ArcadeMode.TrailRide)")
            .substringBefore("if (modeController.mode == ArcadeMode.Biketris)")
        val biketris = tick.substringAfter("if (modeController.mode == ArcadeMode.Biketris)")
            .substringBefore("arcadeContent.playground.controllerAvailable")
        assertTrue(flak.contains("handInput.latest(now)"))
        assertTrue(trail.contains("handInput.latest(now)"))
        assertTrue(biketris.contains("handInput.latest(now)"))
        assertFalse(flak.contains("BricksInputSource"))
        assertFalse(trail.contains("BricksInputSource"))
        assertFalse(biketris.contains("BricksInputSource"))
    }
}
