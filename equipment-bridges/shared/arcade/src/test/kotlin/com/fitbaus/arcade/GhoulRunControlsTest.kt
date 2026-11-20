// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GhoulRunControlsTest {
    private val ms = 1_000_000L

    @Test
    fun staleTelemetryHoldsAndResetsTheClock() {
        val game = GhoulRunGame(seed = 3L)
        val session = GhoulRunSession(game)
        var now = 1_000_000_000L
        var sample = 0
        repeat(140) {
            now += 33 * ms
            if (it % 7 == 0) sample += 1
            session.update(HandPosition(0.5f, 0.5f, 1f, now, HandSource.Camera), CameraState.Ready, true, true, 70, true, "s$sample", now)
        }
        assertTrue(session.cadenceReading.baseline.isFinite())
        now += 3_000 * ms
        session.update(HandPosition(0.5f, 0.5f, 1f, now, HandSource.Camera), CameraState.Ready, true, true, 70, true, "s$sample", now)
        assertEquals(GhoulHold.NoTelemetry, session.hold)
        val elapsed = game.elapsed
        now += 100 * ms
        session.update(HandPosition(0.5f, 0.5f, 1f, now, HandSource.Camera), CameraState.Ready, true, true, 70, true, "s$sample", now)
        assertEquals(elapsed, game.elapsed)
    }

    @Test
    fun controllerDpadStepsOneLaneAndDoesNotNeedFace() {
        val game = GhoulRunGame(seed = 6L)
        val session = GhoulRunSession(game)
        var now = 1_000_000_000L
        var sample = 0
        repeat(120) {
            now += 33 * ms
            if (it % 7 == 0) sample += 1
            session.update(
                HandPosition(0.5f, 0.5f, 0f, now, HandSource.Lost), CameraState.Unavailable,
                true, true, 70, true, "s$sample", now,
                source = GhoulRunInputSource.Controller, controllerAvailable = true, controller = GhoulRunControllerInput(),
            )
        }
        assertEquals(GhoulHold.None, session.hold)
        now += 33 * ms
        session.update(
            HandPosition(0.5f, 0.5f, 0f, now, HandSource.Lost), CameraState.Unavailable,
            true, true, 70, true, "s${++sample}", now,
            source = GhoulRunInputSource.Controller, controllerAvailable = true,
            controller = GhoulRunControllerInput(leftPressed = true),
        )
        assertEquals(GhoulLane.ScreenLeft, session.lane)
    }

    @Test
    fun inputSelectionFallsBackToWebcamWithoutController() {
        assertEquals(GhoulRunInputSource.Webcam, GhoulRunInputSelection.effective(GhoulRunInputSource.Controller.name, false))
        assertEquals(GhoulRunInputSource.Controller, GhoulRunInputSelection.effective(null, true))
        assertEquals(GhoulRunInputSource.Both, GhoulRunInputSelection.effective(GhoulRunInputSource.Both.name, true))
    }

    @Test
    fun webcamFaceLossHoldsButControllerStickMapsAcrossLanes() {
        val supervisor = GhoulRunSupervisor()
        val cadence = CadenceReading(CadenceState.Cruising, 70, 0, 70f, 90f, 0, 0, false)
        val lost = SteerReading(FaceControlState.Lost, 0.5f, 0.5f, 0f, -1L, 0L)
        assertEquals(GhoulHold.FaceLost, supervisor.hold(CameraState.Ready, lost, cadence, GhoulRunInputSource.Webcam, false))

        val game = GhoulRunGame(seed = 10L)
        val session = GhoulRunSession(game)
        var now = 1_000_000_000L
        var sample = 0
        repeat(120) {
            now += 33 * ms
            if (it % 7 == 0) sample += 1
            session.update(
                HandPosition(0.5f, 0.5f, 0f, now, HandSource.Lost), CameraState.Unavailable,
                true, true, 70, true, "stick-$sample", now,
                source = GhoulRunInputSource.Controller, controllerAvailable = true,
                controller = GhoulRunControllerInput(stickX = 1f),
            )
        }
        assertEquals(GhoulLane.ScreenRight, session.lane)
    }
}
