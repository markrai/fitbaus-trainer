// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import com.fitbaus.arcade.ArcadeStatus
import com.fitbaus.arcade.BricksInputSource
import com.fitbaus.arcade.HandPosition
import com.fitbaus.arcade.HandSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BricksInputRoutingTest {
    private val now = 2_000_000_000L
    private val face = HandPosition(0.91f, 0.5f, 0.95f, now, HandSource.Camera)
    private val gamepad = HandPosition(0.14f, 0.5f, 1f, now, HandSource.Touch)
    private val touch = HandPosition(0.67f, 0.4f, 1f, now, HandSource.Touch)

    @Test
    fun controllerModeExcludesCameraWhenInputIsAvailable() {
        val resolved = BricksInputRouting.resolve(
            BricksInputSource.Controller,
            now,
            touch = null,
            controller = gamepad,
            camera = { error("Controller mode must not request face tracking") },
            cameraStatus = { error("Controller mode must not resolve camera status") },
        )
        assertEquals(gamepad, resolved.position)
        assertEquals(ArcadeStatus.ControllerReady, resolved.status)
    }

    @Test
    fun unavailableControllerDoesNotSilentlyRestoreFaceSteering() {
        var faceRequested = false
        val resolved = BricksInputRouting.resolve(
            BricksInputSource.Controller,
            now,
            touch = null,
            controller = null,
            camera = {
                faceRequested = true
                face
            },
            cameraStatus = {
                faceRequested = true
                ArcadeStatus.Tracking
            },
        )
        assertFalse(faceRequested)
        assertEquals(HandSource.Lost, resolved.position.source)
        assertEquals(0.5f, resolved.position.x)
        assertEquals(ArcadeStatus.ControllerUnavailable, resolved.status)
    }

    @Test
    fun webcamModeIgnoresConnectedControllerAndUsesCamera() {
        val resolved = BricksInputRouting.resolve(
            BricksInputSource.Webcam,
            now,
            touch = null,
            controller = gamepad,
            camera = { face },
            cameraStatus = { ArcadeStatus.Tracking },
        )
        assertEquals(face, resolved.position)
        assertEquals(ArcadeStatus.Tracking, resolved.status)
    }

    @Test
    fun touchscreenOverridesControllerWithoutInvokingCamera() {
        val resolved = BricksInputRouting.resolve(
            BricksInputSource.Controller,
            now,
            touch = touch,
            controller = gamepad,
            camera = { error("No camera input while controller selected") },
            cameraStatus = { error("No camera status while controller selected") },
        )
        assertEquals(touch, resolved.position)
        assertEquals(ArcadeStatus.ControllerReady, resolved.status)
        assertTrue(resolved.position.source == HandSource.Touch)
    }
}
