// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GhoulRunStartupModeTest {
    private class Rig(val game: GhoulRunGame, val session: GhoulRunSession, var now: Long) {
        fun tick(source: GhoulRunInputSource, hasController: Boolean = source != GhoulRunInputSource.Webcam) {
            now += 100_000_000L
            val webcam = source != GhoulRunInputSource.Controller
            session.update(
                HandPosition(0.5f, 0.5f, if (webcam) 1f else 0f, now, if (webcam) HandSource.Camera else HandSource.Lost),
                if (webcam) CameraState.Ready else CameraState.Unavailable,
                true,
                true,
                70,
                true,
                "startup-$now",
                now,
                source = source,
                controllerAvailable = hasController,
                controller = if (hasController) GhoulRunControllerInput() else null,
            )
        }
    }

    private fun calibratedRig(seed: Long = 81L): Rig {
        val config = GhoulRunConfig()
        val pace = GhoulPace(config)
        var now = 1_000_000_000L
        repeat(270) {
            now += 100_000_000L
            pace.update(true, true, 70, true, "warm-$now", now)
            pace.advanceWarmup()
        }
        assertTrue(pace.baseline.isFinite())
        val game = GhoulRunGame(config, seed)
        return Rig(game, GhoulRunSession(game, pace = pace, readySeconds = 0f), now)
    }

    @Test
    fun controllerSkipsDirectionsButShowsGoAndPreservesRiderUntilStart() {
        val rig = calibratedRig()
        rig.tick(GhoulRunInputSource.Controller)
        assertEquals(GhoulPhase.LeanCheck, rig.game.phase)
        assertNull(rig.game.leanCheckTarget)
        assertEquals(rig.game.config.leanCheckGoSeconds, rig.game.phaseLeft, 0.001f)
        assertEquals(GhoulState.Inactive, rig.game.ghoul.state)
        val origin = rig.game.riderCell
        repeat(4) { rig.tick(GhoulRunInputSource.Controller) }
        assertEquals(GhoulPhase.LeanCheck, rig.game.phase)
        assertEquals(origin, rig.game.riderCell)
        assertEquals(0f, rig.game.progress)
        assertFalse(rig.game.leanCheckPassed)
        repeat(14) { rig.tick(GhoulRunInputSource.Controller) }
        assertEquals(GhoulPhase.Playing, rig.game.phase)
        assertTrue(rig.game.leanCheckPassed)
        assertEquals(GhoulState.Wandering, rig.game.ghoul.state)
    }

    @Test
    fun firstRunUsesSafeBaselineDuringThreeSecondControllerCountdown() {
        val game = GhoulRunGame(seed = 82L)
        val session = GhoulRunSession(game)
        val rig = Rig(game, session, 1_000_000_000L)
        repeat(15) { rig.tick(GhoulRunInputSource.Controller) }
        assertEquals(GhoulPhase.WarmUp, game.phase)
        assertTrue(session.cadenceReading.calibrated)
        assertEquals(GhoulPaceProfile.DEFAULT_RPM, session.cadenceReading.baseline)
        assertTrue(session.readyRemaining in 1f..2f)
        assertFalse(game.leanCheckPassed)
        repeat(23) { rig.tick(GhoulRunInputSource.Controller) }
        assertEquals(GhoulPhase.Playing, game.phase)
        assertTrue(game.leanCheckPassed)
        assertEquals(GhoulState.Wandering, game.ghoul.state)
    }

    @Test
    fun countdownStopsWhenTelemetryIsMissingAndResumesWithoutSkippingTime() {
        val game = GhoulRunGame(seed = 825L)
        val session = GhoulRunSession(game)
        val rig = Rig(game, session, 1_000_000_000L)
        repeat(10) { rig.tick(GhoulRunInputSource.Controller) }
        val before = session.readyRemaining
        rig.now += 5_000_000_000L
        session.update(
            HandPosition(0.5f, 0.5f, 0f, rig.now, HandSource.Lost),
            CameraState.Unavailable,
            false, false, null, false, null, rig.now,
            source = GhoulRunInputSource.Controller,
            controllerAvailable = true,
            controller = GhoulRunControllerInput(),
        )
        assertEquals(GhoulHold.NoTelemetry, session.hold)
        assertEquals(before, session.readyRemaining, 0.0001f)
        rig.tick(GhoulRunInputSource.Controller)
        assertEquals(before, session.readyRemaining, 0.0001f)
        repeat(35) { rig.tick(GhoulRunInputSource.Controller) }
        assertEquals(GhoulPhase.Playing, game.phase)
    }

    @Test
    fun webcamAndBothModesRetainDirectionalVerification() {
        for (source in listOf(GhoulRunInputSource.Webcam, GhoulRunInputSource.Both)) {
            val rig = calibratedRig()
            repeat(24) { rig.tick(source) }
            assertEquals(GhoulPhase.LeanCheck, rig.game.phase, "mode $source")
            assertEquals(GhoulLane.Left, rig.game.leanCheckTarget, "mode $source")
            assertFalse(rig.game.leanCheckPassed)
        }
    }

    @Test
    fun changingFromWebcamToControllerDuringVerificationShowsGo() {
        val rig = calibratedRig()
        repeat(24) { rig.tick(GhoulRunInputSource.Webcam) }
        assertEquals(GhoulLane.Left, rig.game.leanCheckTarget)
        rig.tick(GhoulRunInputSource.Controller)
        assertEquals(GhoulPhase.LeanCheck, rig.game.phase)
        assertNull(rig.game.leanCheckTarget)
        assertEquals(GhoulState.Inactive, rig.game.ghoul.state)
        repeat(14) { rig.tick(GhoulRunInputSource.Controller) }
        assertEquals(GhoulPhase.Playing, rig.game.phase)
    }

    @Test
    fun changingFromControllerToWebcamDuringGoRestoresFaceCheck() {
        val rig = calibratedRig()
        rig.tick(GhoulRunInputSource.Controller)
        assertNull(rig.game.leanCheckTarget)
        repeat(24) { rig.tick(GhoulRunInputSource.Webcam) }
        assertEquals(GhoulPhase.LeanCheck, rig.game.phase)
        assertEquals(GhoulLane.Left, rig.game.leanCheckTarget)
        assertFalse(rig.game.leanCheckPassed)
    }

    @Test
    fun changingFromControllerToBothDuringGoRestoresFaceCheck() {
        val rig = calibratedRig()
        rig.tick(GhoulRunInputSource.Controller)
        rig.tick(GhoulRunInputSource.Both)
        assertEquals(GhoulPhase.LeanCheck, rig.game.phase)
        assertEquals(GhoulLane.Left, rig.game.leanCheckTarget)
    }

    @Test
    fun switchingFromControllerToWebcamDuringCountdownStillChecksLean() {
        val game = GhoulRunGame(seed = 826L)
        val rig = Rig(game, GhoulRunSession(game), 1_000_000_000L)
        repeat(20) { rig.tick(GhoulRunInputSource.Controller) }
        assertEquals(GhoulPhase.WarmUp, game.phase)
        repeat(50) { rig.tick(GhoulRunInputSource.Webcam) }
        assertEquals(GhoulPhase.LeanCheck, game.phase)
        assertEquals(GhoulLane.Left, game.leanCheckTarget)
        assertFalse(game.leanCheckPassed)
    }

    @Test
    fun nextLevelUsesExistingResultsCountdownWithoutExtraReadyDelay() {
        val game = GhoulRunGame(seed = 827L)
        val rig = Rig(game, GhoulRunSession(game), 1_000_000_000L)
        repeat(40) { rig.tick(GhoulRunInputSource.Controller) }
        assertEquals(GhoulPhase.Playing, game.phase)
        game.visitForTest(game.world.exit)
        assertEquals(GhoulPhase.Results, game.phase)
        game.step(game.config.resultsSeconds + 0.1f, GhoulLane.Center, 0f, 70f, 70f)
        assertEquals(GhoulPhase.Countdown, game.phase)
        game.step(game.config.restartCountdownSeconds + 0.1f, GhoulLane.Center, 0f, 70f, 70f)
        assertEquals(GhoulPhase.WarmUp, game.phase)
        assertEquals(2, game.level)
        repeat(3) { rig.tick(GhoulRunInputSource.Controller) }
        assertEquals(GhoulPhase.Playing, game.phase)
        assertEquals(2, game.ghouls.size)
    }

    @Test
    fun laterMazesDoNotRepeatControllerVerification() {
        val rig = calibratedRig()
        repeat(17) { rig.tick(GhoulRunInputSource.Controller) }
        assertEquals(GhoulPhase.Playing, rig.game.phase)
        rig.game.restart(83L)
        assertEquals(GhoulPhase.WarmUp, rig.game.phase)
        rig.tick(GhoulRunInputSource.Controller)
        assertEquals(GhoulPhase.WarmUp, rig.game.phase)
        rig.tick(GhoulRunInputSource.Controller)
        assertEquals(GhoulPhase.Playing, rig.game.phase)
    }
}
