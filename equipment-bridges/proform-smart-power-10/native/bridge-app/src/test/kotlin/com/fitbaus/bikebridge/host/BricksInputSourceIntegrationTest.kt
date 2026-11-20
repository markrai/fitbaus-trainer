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
        assertTrue(bricks.contains("val source = arcadeContent.playground.inputSource"))
        assertTrue(bricks.contains("val touch = if (handInput.isTouching()) handInput.latest(now) else null"))
        assertTrue(bricks.contains("if (source == BricksInputSource.Controller && touch == null)"))
        assertTrue(bricks.contains("exclusiveHid.sampleBricks(now)"))
        assertTrue(bricks.contains("gameController.sample(now)"))
        assertTrue(bricks.contains("val frame = BricksInputRouting.resolve("))
        assertTrue(bricks.contains("camera = { handInput.latest(now) }"))
        assertTrue(bricks.contains("cameraStatus = {"))
        assertTrue(bricks.contains("arcadeContent.playground.render(frame.position, frame.status"))
        assertFalse(bricks.contains("controllerPosition ?: handInput.latest(now)"))
        assertTrue(gamepad.contains("fun hasController(): Boolean = activeDeviceId >= 0"))
    }

    @Test
    fun uncalibratedHidDoesNotDetachAndroidControllerAndSettingsStayUsable() {
        val main = host.substringAfter("private val controllerOwnership by lazy")
            .substringBefore("private val gameBindings")
        assertTrue(main.contains("canClaim = {"))
        assertTrue(main.contains("exclusiveHid.hasCalibratedBricksInput()"))
        assertTrue(main.contains("modeController.mode == ArcadeMode.Bricks"))
        val settings = File("src/main/kotlin/com/fitbaus/bikebridge/host/PairingActivity.kt").readText()
        assertTrue(settings.contains("canClaim = { rawLearningRequested }"))
        assertTrue(settings.contains("rawLearningRequested = true"))
        assertTrue(settings.contains("controllerOwnership.refreshNow()"))
        assertTrue(settings.contains("private fun prepareRawNeutral()"))
        assertTrue(settings.contains(".putString(ExclusiveHidPolicy.PREF_KEY, candidate.key)"))
    }

    @Test
    fun webcamSelectionBlocksBricksControllerActionsButStillConsumesDeviceEvents() {
        val keys = host.substringAfter("override fun dispatchKeyEvent(event: KeyEvent)")
            .substringBefore("private fun performMappedGameAction")
        assertTrue(keys.contains("val controllerEnabled = when (mode) {"))
        assertTrue(keys.contains("ArcadeMode.Bricks -> arcadeContent.playground.inputSource == BricksInputSource.Controller"))
        assertTrue(keys.contains("ArcadeMode.Biketris -> arcadeContent.biketris.inputSource == BiketrisInputSource.Controller"))
        assertTrue(keys.contains("matches && controllerEnabled"))
        assertTrue(keys.contains("steerBricks = modeController.isActive && controllerEnabled"))
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
