// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
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
        assertEquals(GhoulLane.Left, session.lane)
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

    @Test
    fun leanZonesEnterAtThirtyFiveAndLeaveBelowTwenty() {
        val config = GhoulRunConfig()
        assertEquals(0.35f, config.leanEnter)
        assertEquals(0.20f, config.leanExit)
        val zones = GhoulLeanZones(config.leanEnter, config.leanExit)
        assertEquals(GhoulLane.Center, zones.update(0.34f))
        assertEquals(GhoulLane.Right, zones.update(0.35f))
        assertEquals(GhoulLane.Right, zones.update(0.21f), "hysteresis keeps the side until below the exit")
        assertEquals(GhoulLane.Center, zones.update(0.19f))
        assertEquals(GhoulLane.Center, zones.update(-0.34f))
        assertEquals(GhoulLane.Left, zones.update(-0.35f), "steer < 0 is the rider's left")
        assertEquals(GhoulLane.Left, zones.update(-0.21f))
        assertEquals(GhoulLane.Right, zones.update(0.5f), "a full swing crosses straight to the other side")
        assertEquals(GhoulLane.Center, zones.update(0.1f))
    }

    @Test
    fun headAndStickLeanHeldTenSecondsNeverReverseTheRider() {
        for (useStick in listOf(false, true)) {
            val config = GhoulRunConfig()
            val pace = GhoulPace(config)
            var now = feed(pace, config.warmupSeconds + 0.2f, 70)
            val game = GhoulRunGame(config, seed = 9L)
            game.step(config.step, GhoulLane.Center, 0f, 70f, 70f)
            game.skipLeanCheck()
            val session = GhoulRunSession(game, pace = pace)
            val source = if (useStick) GhoulRunInputSource.Controller else GhoulRunInputSource.Webcam
            var previous = game.heading
            var previousTurning = game.turningLeft
            var sawLeft = false
            repeat(((10f + 1.5f) * 30).toInt()) { index ->
                now += 33 * ms
                val leaning = index > 45
                val faceX = if (!useStick && leaning) 0.15f else 0.5f
                session.update(
                    HandPosition(faceX, 0.5f, 1f, now, if (useStick) HandSource.Lost else HandSource.Camera),
                    if (useStick) CameraState.Unavailable else CameraState.Ready,
                    true,
                    true,
                    70,
                    true,
                    "lean-$useStick-$index",
                    now,
                    source = source,
                    controllerAvailable = useStick,
                    controller = if (useStick) GhoulRunControllerInput(stickX = if (leaning) -1f else 0f) else null,
                )
                if (leaning && session.live) {
                    // Left until a taken turn uses the selection up; then centre until the lean is released.
                    assertTrue(session.lane == GhoulLane.Left || (session.rearming && session.lane == GhoulLane.Center))
                    if (session.lane == GhoulLane.Left) sawLeft = true
                }
                if (game.heading == previous.opposite) {
                    assertTrue(previousTurning > 0f, "only a dead end may reverse the rider (stick=$useStick)")
                }
                previous = game.heading
                previousTurning = game.turningLeft
            }
            assertTrue(sawLeft)
            assertTrue(game.lean <= -0.99f, "full lean reaches the game (stick=$useStick)")
        }
    }

    private class LiveRig(val game: GhoulRunGame, val session: GhoulRunSession, var now: Long)

    private fun liveRig(seed: Long): LiveRig {
        val config = GhoulRunConfig()
        val pace = GhoulPace(config)
        val now = feed(pace, config.warmupSeconds + 0.2f, 70)
        val game = GhoulRunGame(config, seed = seed)
        game.step(config.step, GhoulLane.Center, 0f, 70f, 70f)
        game.skipLeanCheck()
        game.ghoul.state = GhoulState.Inactive
        return LiveRig(game, GhoulRunSession(game, pace = pace), now)
    }

    private fun LiveRig.tick(faceX: Float = 0.5f, controller: GhoulRunControllerInput? = null) {
        now += 33 * ms
        val pad = controller != null
        session.update(
            HandPosition(faceX, 0.5f, 1f, now, if (pad) HandSource.Lost else HandSource.Camera),
            if (pad) CameraState.Unavailable else CameraState.Ready,
            true,
            true,
            70,
            true,
            "t$now",
            now,
            source = if (pad) GhoulRunInputSource.Controller else GhoulRunInputSource.Webcam,
            controllerAvailable = pad,
            controller = controller,
        )
    }

    /** Places the rider just before a real choice whose left opening is free. */
    private fun LiveRig.approachLeftChoice() {
        for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val junction = MazeCell(row, col)
            for (arrival in MazeDirection.entries) {
                if (!game.world.isOpen(junction, arrival.opposite)) continue
                val allowed = game.world.exits(junction).filter { it != arrival.opposite }
                if (allowed.size >= 2 && arrival.relativeLeft in allowed) {
                    game.placeRider(junction.moved(arrival.opposite), arrival, 0.05f)
                    return
                }
            }
        }
        error("no left choice")
    }

    @Test
    fun aHeldLeanTakesOneTurnThenMustRecentre() {
        val rig = liveRig(seed = 9L)
        repeat(60) { rig.tick() }
        rig.approachLeftChoice()
        val arrival = rig.game.heading
        val turns = rig.game.choiceTurns
        var guard = 0
        while (rig.game.choiceTurns == turns && guard++ < 200) rig.tick(faceX = 0.15f)
        assertEquals(arrival.relativeLeft, rig.game.heading, "the lean takes the left")
        repeat(90) {
            rig.tick(faceX = 0.15f)
            assertEquals(GhoulLane.Center, rig.session.lane, "a lean held through the turn does not chain another")
        }
        assertTrue(rig.session.rearming)
        rig.tick(faceX = 0.5f)
        assertFalse(rig.session.rearming)
        rig.tick(faceX = 0.15f)
        assertEquals(GhoulLane.Left, rig.session.lane, "leaning again after centering selects left")
    }

    /** Places the rider just before a fork whose straight is blocked and whose left is open. */
    private fun LiveRig.approachBlockedForkWithLeft(): Pair<MazeCell, MazeDirection> {
        for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val junction = MazeCell(row, col)
            for (arrival in MazeDirection.entries) {
                if (!game.world.isOpen(junction, arrival.opposite)) continue
                val allowed = game.world.exits(junction).filter { it != arrival.opposite }
                if (arrival !in allowed && arrival.relativeLeft in allowed) {
                    game.placeRider(junction.moved(arrival.opposite), arrival, 0.05f)
                    return junction to arrival
                }
            }
        }
        error("no blocked fork with a left")
    }

    @Test
    fun aLeanHeldFromTheLastTurnCountsAtABlockedFork() {
        val rig = liveRig(seed = 9L)
        repeat(60) { rig.tick() }
        rig.approachLeftChoice()
        val turns = rig.game.choiceTurns
        var guard = 0
        while (rig.game.choiceTurns == turns && guard++ < 200) rig.tick(faceX = 0.15f)
        rig.tick(faceX = 0.15f)
        assertTrue(rig.session.rearming, "the last turn used up the lean")

        val (fork, arrival) = rig.approachBlockedForkWithLeft()
        guard = 0
        while (rig.game.heading == arrival && guard++ < 300) rig.tick(faceX = 0.15f)
        assertEquals(fork, rig.game.riderCell)
        assertEquals(arrival.relativeLeft, rig.game.heading, "the held lean turns at the fork without re-centering")
        rig.tick(faceX = 0.15f)
        assertTrue(rig.session.rearming, "the fork turn uses the lean up again, so it cannot chain on")
    }

    @Test
    fun controllerPressArmsOnlyTheNextTurn() {
        val rig = liveRig(seed = 9L)
        val idle = GhoulRunControllerInput()
        repeat(10) { rig.tick(controller = idle) }
        rig.tick(controller = GhoulRunControllerInput(leftPressed = true))
        assertEquals(GhoulLane.Left, rig.session.lane)
        rig.tick(controller = GhoulRunControllerInput(leftPressed = true))
        assertEquals(GhoulLane.Center, rig.session.lane, "pressing the same side again cancels")
        rig.tick(controller = GhoulRunControllerInput(rightPressed = true))
        assertEquals(GhoulLane.Right, rig.session.lane)
        rig.tick(controller = GhoulRunControllerInput(leftPressed = true))
        assertEquals(GhoulLane.Left, rig.session.lane, "the other side switches directly")

        rig.approachLeftChoice()
        val arrival = rig.game.heading
        val turns = rig.game.choiceTurns
        var guard = 0
        while (rig.game.choiceTurns == turns && guard++ < 200) rig.tick(controller = idle)
        assertEquals(arrival.relativeLeft, rig.game.heading)
        rig.tick(controller = idle)
        assertEquals(GhoulLane.Center, rig.session.lane, "the press was used up by the turn")
    }

    @Test
    fun controllerReverseClearsArmedTurnAndDoesNotRepeatOnIdleFrames() {
        val rig = liveRig(seed = 9L)
        val idle = GhoulRunControllerInput()
        repeat(10) { rig.tick(controller = idle) }
        val cell = rig.game.world.start
        val direction = rig.game.world.exits(cell).first()
        rig.game.placeRider(cell, direction, 0.3f)
        rig.tick(controller = GhoulRunControllerInput(leftPressed = true))
        assertEquals(GhoulLane.Left, rig.session.lane)
        rig.tick(controller = GhoulRunControllerInput(reversePressed = true))
        assertEquals(direction.opposite, rig.game.heading)
        assertEquals(GhoulLane.Center, rig.session.lane)
        rig.tick(controller = idle)
        assertEquals(direction.opposite, rig.game.heading)
    }

    @Test
    fun releasedStickRecentres() {
        val game = GhoulRunGame(seed = 6L)
        val session = GhoulRunSession(game)
        var now = 1_000_000_000L
        fun tick(stick: Float, index: Int) {
            now += 100 * ms
            session.update(
                HandPosition(0.5f, 0.5f, 0f, now, HandSource.Lost),
                CameraState.Unavailable,
                true,
                true,
                70,
                true,
                "stick$index",
                now,
                source = GhoulRunInputSource.Controller,
                controllerAvailable = true,
                controller = GhoulRunControllerInput(stickX = stick),
            )
        }
        tick(1f, 0)
        assertEquals(GhoulLane.Right, session.lane)
        tick(0f, 1)
        assertEquals(GhoulLane.Center, session.lane)
    }
}
