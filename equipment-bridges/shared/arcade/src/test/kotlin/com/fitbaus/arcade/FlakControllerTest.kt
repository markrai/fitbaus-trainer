// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FlakControllerTest {
    @Test
    fun sourceDefaultsToControllerWhenConnectedAndHonorsWebcamChoice() {
        assertEquals(FlakInputSource.Webcam, FlakInputSelection.effective(null, false))
        assertEquals(FlakInputSource.Controller, FlakInputSelection.effective(null, true))
        assertEquals(FlakInputSource.Webcam, FlakInputSelection.effective("Webcam", true))
        assertEquals(FlakInputSource.Webcam, FlakInputSelection.effective("Controller", false))
        assertEquals(FlakInputSource.Controller, FlakInputSelection.effective("Controller", true))
        assertEquals(FlakInputSource.Controller, FlakInputSelection.effective("Both", true))
        assertEquals("flak_input_source", FlakInputSelection.PREF_KEY)
        assertFalse(FlakInputSelection.PREF_KEY == BiketrisInputSelection.PREF_KEY)
    }

    @Test
    fun stickAndDpadSteeringMovesInBothAxesAndNeutralHoldsTheTarget() {
        val config = FlakConfig()
        val game = FlakGame(config, autoSpawn = false)
        val steering = FlakControllerSteering(config)
        steering.syncToJet(game.jetX, game.jetY)
        val startX = steering.targetX
        val startY = steering.targetY
        var now = 2_000_000_000L
        steering.advance(FlakControllerInput(1f, -1f), now)
        assertEquals(startX, steering.targetX, 0.00001f)
        assertEquals(startY, steering.targetY, 0.00001f)
        repeat(5) {
            now += 50_000_000L
            val (x, y) = steering.advance(FlakControllerInput(1f, -1f), now)
            game.step(0.05f, y, false, x)
        }
        assertTrue(steering.targetX > startX)
        assertTrue(steering.targetY < startY)
        assertTrue(game.jetX > game.config.jetMinX)
        assertTrue(game.jetY < (config.bandTop + config.bandBottom) / 2f)
        val holdX = steering.targetX
        val holdY = steering.targetY
        repeat(8) {
            now += 50_000_000L
            val (x, y) = steering.advance(FlakControllerInput(), now)
            game.step(0.05f, y, false, x)
        }
        assertEquals(holdX, steering.targetX, 0.00001f)
        assertEquals(holdY, steering.targetY, 0.00001f)
    }

    @Test
    fun controllerTargetsClampAndIgnoreInvalidStickSamples() {
        val config = FlakConfig()
        val steering = FlakControllerSteering(config)
        steering.syncToJet(config.jetMinX, config.bandTop)
        var now = 5_000_000_000L
        steering.advance(FlakControllerInput(-1f, -1f), now)
        repeat(8) {
            now += 100_000_000L
            steering.advance(FlakControllerInput(-1f, -1f), now)
        }
        assertEquals(0f, steering.targetX, 0.00001f)
        assertEquals(0f, steering.targetY, 0.00001f)
        steering.advance(FlakControllerInput(Float.NaN, Float.POSITIVE_INFINITY), now + 100_000_000L)
        assertEquals(0f, steering.targetX, 0.00001f)
        assertEquals(0f, steering.targetY, 0.00001f)
        repeat(40) {
            now += 100_000_000L
            steering.advance(FlakControllerInput(1f, 1f), now)
        }
        assertEquals(1f, steering.targetX, 0.00001f)
        assertEquals(1f, steering.targetY, 0.00001f)
    }

    @Test
    fun noCatchUpMovementAfterPauseOrStalledFrames() {
        val config = FlakConfig()
        val steering = FlakControllerSteering(config)
        steering.syncToJet(config.jetMinX + 65f, config.bandTop + 49f)
        var now = 1_000_000_000L
        steering.advance(FlakControllerInput(1f, 0f), now)
        now += 100_000_000L
        val normal = steering.advance(FlakControllerInput(1f, 0f), now).first
        steering.pause()
        now += 10_000_000_000L
        assertEquals(normal, steering.advance(FlakControllerInput(1f, 0f), now).first, 0.00001f)
        now += 5_000_000_000L
        val limited = steering.advance(FlakControllerInput(1f, 0f), now).first
        assertEquals(config.sideSpeed * 0.1f / (config.jetMaxX - config.jetMinX), limited - normal, 0.00001f)
    }

    @Test
    fun controllerModeDoesNotDependOnCameraButStillRequiresBikeData() {
        val supervisor = FlakSupervisor()
        val face = FaceControlReading(FaceControlState.Lost, 0.5f, Float.NaN, 0.5f, -1L, 0L)
        fun sample(state: CadenceState) = CadenceReading(state, 70, 0L, 70f, 70f, 0L, 0, false)
        assertEquals(
            FlakHold.ControllerUnavailable,
            supervisor.hold(CameraState.Unavailable, face, sample(CadenceState.Cruising),
                FlakInputSource.Controller, controllerReady = false),
        )
        assertEquals(
            FlakHold.None,
            supervisor.hold(CameraState.Unavailable, face, sample(CadenceState.Cruising),
                FlakInputSource.Controller, controllerReady = true),
        )
        assertEquals(
            FlakHold.NoTelemetry,
            supervisor.hold(CameraState.Unavailable, face, sample(CadenceState.Stale),
                FlakInputSource.Controller, controllerReady = true),
        )
        assertEquals(
            FlakHold.NotPedaling,
            supervisor.hold(CameraState.Unavailable, face, sample(CadenceState.Stopped),
                FlakInputSource.Controller, controllerReady = true),
        )
        assertEquals(
            FlakHold.CameraUnavailable,
            supervisor.hold(CameraState.Unavailable, face, sample(CadenceState.Cruising)),
        )
        assertTrue(supervisor.message(FlakHold.ControllerUnavailable, sample(CadenceState.Cruising))!!.contains("CONTROLLER"))
    }
}
