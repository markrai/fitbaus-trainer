// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GhoulRunControlsTest {
    private val ms = 1_000_000L

    private fun feed(pace: GhoulPace, seconds: Float, rpm: Int, start: Long = 1_000_000_000L): Long {
        var now = start
        repeat((seconds * 10).toInt() + 1) { index ->
            now += 100 * ms
            pace.update(true, true, rpm, true, "sample-$now-$index", now)
            pace.advanceWarmup()
        }
        return now
    }

    @Test
    fun warmupLocksMedianAndSteadySprintNeverRebaselines() {
        val config = GhoulRunConfig()
        val pace = GhoulPace(config)
        var now = feed(pace, config.warmupSeconds + 0.2f, 70)
        val baseline = pace.baseline
        assertEquals(70f, baseline, 0.5f)
        now = feed(pace, 60f, 90, now)
        assertEquals(baseline, pace.baseline, 0f)
        assertEquals(config.sprintSpeed, GhoulRunGame(config).speedFor(pace.reading.filteredRpm, baseline), 0.05f)

        val creep = GhoulPace(config)
        var creepNow = feed(creep, config.warmupSeconds + 0.2f, 70)
        val creepBaseline = creep.baseline
        creepNow = feed(creep, 60f, 55, creepNow)
        assertEquals(creepBaseline, creep.baseline, 0f)
        assertEquals(config.creepSpeed, GhoulRunGame(config).speedFor(creep.reading.filteredRpm, creepBaseline), 0.05f)
        assertTrue(now > creepNow - 1L)
    }

    @Test
    fun longStopDoesNotRetrainAndBelowTwentyStopsTheRider() {
        val config = GhoulRunConfig()
        val pace = GhoulPace(config)
        var now = feed(pace, config.warmupSeconds + 0.2f, 70)
        val baseline = pace.baseline
        now = feed(pace, 30f, 0, now)
        assertEquals(baseline, pace.baseline, 0f)
        val game = GhoulRunGame(config)
        assertEquals(0f, game.speedFor(pace.reading.filteredRpm, baseline))
        assertEquals(0f to 0f, game.radiiFor(pace.reading.filteredRpm, baseline))
    }

    @Test
    fun staleTelemetryHoldsAndResetsTheClock() {
        val game = GhoulRunGame(seed = 3L)
        val session = GhoulRunSession(game)
        var now = 1_000_000_000L
        var sample = 0
        repeat(180) {
            now += 33 * ms
            if (it % 3 == 0) sample += 1
            session.update(
                HandPosition(0.5f, 0.5f, 1f, now, HandSource.Camera),
                CameraState.Ready,
                true,
                true,
                70,
                true,
                "s$sample",
                now,
            )
        }
        now += 3_000 * ms
        session.update(
            HandPosition(0.5f, 0.5f, 1f, now, HandSource.Camera),
            CameraState.Ready,
            true,
            true,
            70,
            true,
            "s$sample",
            now,
        )
        assertEquals(GhoulHold.NoTelemetry, session.hold)
        val elapsed = game.elapsed
        now += 100 * ms
        session.update(
            HandPosition(0.5f, 0.5f, 1f, now, HandSource.Camera),
            CameraState.Ready,
            true,
            true,
            70,
            true,
            "s$sample",
            now,
        )
        assertEquals(elapsed, game.elapsed)
    }

    @Test
    fun controllerStepsSelectionsAndDoesNotNeedFace() {
        val game = GhoulRunGame(seed = 6L)
        val session = GhoulRunSession(game)
        var now = 1_000_000_000L
        repeat(30) { index ->
            now += 100 * ms
            session.update(
                HandPosition(0.5f, 0.5f, 0f, now, HandSource.Lost),
                CameraState.Unavailable,
                true,
                true,
                70,
                true,
                "s$index",
                now,
                source = GhoulRunInputSource.Controller,
                controllerAvailable = true,
                controller = GhoulRunControllerInput(),
            )
        }
        assertEquals(GhoulHold.None, session.hold)
        now += 100 * ms
        session.update(
            HandPosition(0.5f, 0.5f, 0f, now, HandSource.Lost),
            CameraState.Unavailable,
            true,
            true,
            70,
            true,
            "left",
            now,
            source = GhoulRunInputSource.Controller,
            controllerAvailable = true,
            controller = GhoulRunControllerInput(leftPressed = true),
        )
        assertEquals(GhoulLane.ScreenLeft, session.lane)
    }

    @Test
    fun inputSelectionAndWebcamFaceHoldArePreserved() {
        assertEquals(GhoulRunInputSource.Webcam, GhoulRunInputSelection.effective(GhoulRunInputSource.Controller.name, false))
        assertEquals(GhoulRunInputSource.Controller, GhoulRunInputSelection.effective(null, true))
        assertEquals(GhoulRunInputSource.Both, GhoulRunInputSelection.effective(GhoulRunInputSource.Both.name, true))

        val supervisor = GhoulRunSupervisor()
        val cadence = GhoulCadenceReading(CadenceStatus.Live, 70, 70f, 70f, 0f)
        val lost = SteerReading(FaceControlState.Lost, 0.5f, 0.5f, 0f, -1L, 0L)
        assertEquals(GhoulHold.FaceLost, supervisor.hold(CameraState.Ready, lost, cadence, GhoulRunInputSource.Webcam, false))
    }
}
