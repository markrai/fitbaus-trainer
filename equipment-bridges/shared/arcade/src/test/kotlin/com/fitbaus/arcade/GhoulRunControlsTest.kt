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
    fun startupUsesConservativeCadenceWithoutWaitingForMeasuredBaseline() {
        val pace = GhoulPace(GhoulRunConfig())
        assertEquals(GhoulPaceProfile.DEFAULT_RPM, pace.baseline)
        assertEquals(GhoulPaceProfile.DEFAULT_RPM, pace.reading.baseline)
        assertTrue(pace.reading.calibrated)
        assertFalse(pace.learnedBaseline.isFinite())
        val game = GhoulRunGame()
        assertEquals(game.config.cruiseSpeed, game.speedFor(70f, pace.baseline), 0.001f)
        assertEquals(0f, game.speedFor(0f, pace.baseline))
    }

    @Test
    fun learnedPaceIsCapturedInBackgroundAndAppliedGradually() {
        val config = GhoulRunConfig()
        val pace = GhoulPace(config)
        val now = feed(pace, config.warmupSeconds + 2f, 94)
        assertEquals(94f, pace.learnedBaseline, 2f)
        assertTrue(pace.baseline > GhoulPaceProfile.DEFAULT_RPM)
        assertTrue(pace.baseline < pace.learnedBaseline)
        val initial = pace.baseline
        feed(pace, 1f, 94, now)
        assertTrue(pace.baseline - initial <= 2f)
        assertTrue(pace.baseline > initial)
        val remembered = GhoulPace(config, initialBaseline = pace.learnedBaseline)
        assertEquals(pace.learnedBaseline, remembered.baseline)
        assertEquals(0f, remembered.reading.warmupRemaining)
        assertFalse(remembered.learnedBaseline.isFinite())
        remembered.recalibrate()
        assertEquals(GhoulPaceProfile.DEFAULT_RPM, remembered.baseline)
        assertEquals(config.warmupSeconds, remembered.reading.warmupRemaining)
    }

    @Test
    fun savedPaceMustBePlausibleRecentAndFromThePast() {
        val now = 2_000_000_000_000L
        val day = 24L * 60L * 60L * 1000L
        assertEquals(93f, GhoulPaceProfile.restore(93f, now - 10L * day, now))
        assertFalse(GhoulPaceProfile.restore(93f, now - 31L * day, now).isFinite())
        assertFalse(GhoulPaceProfile.restore(93f, now + day, now).isFinite())
        assertFalse(GhoulPaceProfile.restore(0f, now - day, now).isFinite())
        assertFalse(GhoulPaceProfile.restore(170f, now - day, now).isFinite())
        assertFalse(GhoulPaceProfile.restore(Float.NaN, now - day, now).isFinite())
        assertFalse(GhoulPaceProfile.restore(93f, 0L, now).isFinite())
    }

    @Test
    fun backgroundLearnerRejectsStoppedCadenceAndDoesNotRelearnSprint() {
        val config = GhoulRunConfig()
        val pace = GhoulPace(config)
        val stopped = feed(pace, 40f, 0)
        assertFalse(pace.learnedBaseline.isFinite())
        assertEquals(GhoulPaceProfile.DEFAULT_RPM, pace.baseline)
        val trained = feed(pace, config.warmupSeconds + 1f, 75, stopped)
        assertEquals(75f, pace.learnedBaseline, 1f)
        val saved = pace.learnedBaseline
        feed(pace, 35f, 115, trained)
        assertEquals(saved, pace.learnedBaseline)
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
        assertEquals(GhoulLane.Center, session.lane, "warm-up input cannot queue a future turn")
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
                    if (!useStick) assertEquals(GhoulLane.Left, session.lane)
                    else assertTrue(session.lane == GhoulLane.Left || session.lane == GhoulLane.Center)
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

    private fun LiveRig.tick(faceX: Float = 0.5f, controller: GhoulRunControllerInput? = null, rpm: Int = 70) {
        now += 33 * ms
        val pad = controller != null
        session.update(
            HandPosition(faceX, 0.5f, 1f, now, if (pad) HandSource.Lost else HandSource.Camera),
            if (pad) CameraState.Unavailable else CameraState.Ready,
            true,
            true,
            rpm,
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
    fun continuousWebcamLeanRemainsActiveThroughTurns() {
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
            assertEquals(GhoulLane.Left, rig.session.lane, "a lean held through the turn stays available for the next junction")
        }
        rig.tick(faceX = 0.5f)
        assertEquals(GhoulLane.Center, rig.session.lane)
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
                if (allowed.size >= 2 && arrival !in allowed && arrival.relativeLeft in allowed) {
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
        assertEquals(GhoulLane.Left, rig.session.lane, "continuous webcam lean stays selected")

        val (fork, arrival) = rig.approachBlockedForkWithLeft()
        guard = 0
        while (rig.game.heading == arrival && guard++ < 300) rig.tick(faceX = 0.15f)
        assertEquals(fork, rig.game.riderCell)
        assertEquals(arrival.relativeLeft, rig.game.heading, "the held lean turns at the fork without re-centering")
        rig.tick(faceX = 0.15f)
        assertEquals(GhoulLane.Left, rig.session.lane, "the blocked fork does not consume webcam lean")
    }

    private fun LiveRig.approachConsecutiveChoices(): Pair<GhoulLane, GhoulLane> {
        for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val first = MazeCell(row, col)
            for (incoming in MazeDirection.entries) {
                if (!game.world.isOpen(first.moved(incoming.opposite), incoming)) continue
                if (game.world.exits(first).count { it != incoming.opposite } < 2) continue
                for (firstLane in listOf(GhoulLane.Left, GhoulLane.Right)) {
                    val firstTurn = game.choiceFor(first, incoming, firstLane) ?: continue
                    if (firstTurn == incoming || firstTurn == incoming.opposite) continue
                    if (!game.world.isOpen(first, firstTurn)) continue
                    val second = first.moved(firstTurn)
                    if (game.world.exits(second).count { it != firstTurn.opposite } < 2) continue
                    for (secondLane in listOf(GhoulLane.Left, GhoulLane.Right)) {
                        val secondTurn = game.choiceFor(second, firstTurn, secondLane) ?: continue
                        if (secondTurn == firstTurn || secondTurn == firstTurn.opposite) continue
                        game.placeRider(first.moved(incoming.opposite), incoming, 0.55f)
                        return firstLane to secondLane
                    }
                }
            }
        }
        error("no adjacent choice junctions")
    }

    private fun LiveRig.approachStraightChoice() {
        for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val junction = MazeCell(row, col)
            for (incoming in MazeDirection.entries) {
                if (!game.world.isOpen(junction.moved(incoming.opposite), incoming)) continue
                if (game.world.exits(junction).count { it != incoming.opposite } < 2) continue
                if (!game.world.isOpen(junction, incoming)) continue
                if (!game.world.isOpen(junction, incoming.relativeLeft)) continue
                game.placeRider(junction.moved(incoming.opposite), incoming, 0.05f)
                return
            }
        }
        error("no straight-ahead choice junction")
    }

    @Test
    fun controllerOnlyArmsTurnsAtTheApproachingJunction() {
        val rig = liveRig(seed = 9L)
        rig.approachStraightChoice()
        val approaching = rig.game.riderCell.moved(rig.game.heading)
        val arrival = rig.game.heading
        val selected = rig.game.choiceDecisions
        rig.tick(controller = GhoulRunControllerInput(leftPressed = true))
        assertEquals(GhoulLane.Left, rig.session.lane)
        rig.tick(controller = GhoulRunControllerInput())
        assertEquals(GhoulLane.Left, rig.session.lane)
        var guard = 0
        while (rig.game.choiceDecisions == selected && guard++ < 100) rig.tick(controller = GhoulRunControllerInput())
        assertEquals(approaching, rig.game.riderCell)
        assertEquals(arrival.relativeLeft, rig.game.heading)
        assertEquals(GhoulLane.Center, rig.session.lane)
    }

    @Test
    fun rapidControllerPressesApplyToAdjacentChoiceJunctionsOnly() {
        val rig = liveRig(seed = 9L)
        val (first, second) = rig.approachConsecutiveChoices()
        val initialHeading = rig.game.heading
        val firstJunction = rig.game.riderCell.moved(initialHeading)
        val nextHeading = if (first == GhoulLane.Left) initialHeading.relativeLeft else initialHeading.relativeRight
        val firstDecision = rig.game.choiceDecisions
        rig.tick(controller = if (first == GhoulLane.Left) GhoulRunControllerInput(leftPressed = true) else GhoulRunControllerInput(rightPressed = true))
        rig.tick(controller = if (second == GhoulLane.Left) GhoulRunControllerInput(leftPressed = true) else GhoulRunControllerInput(rightPressed = true))
        assertEquals(first, rig.session.lane)
        var guard = 0
        while (rig.game.choiceDecisions == firstDecision && guard++ < 110) rig.tick(controller = GhoulRunControllerInput())
        assertEquals(firstJunction, rig.game.riderCell)
        assertEquals(nextHeading, rig.game.heading)
        assertEquals(second, rig.session.lane)
        guard = 0
        while (rig.game.choiceDecisions == firstDecision + 1 && guard++ < 110) rig.tick(controller = GhoulRunControllerInput())
        assertEquals(if (second == GhoulLane.Left) nextHeading.relativeLeft else nextHeading.relativeRight, rig.game.heading)
        assertEquals(GhoulLane.Center, rig.session.lane)
    }

    @Test
    fun neutralControllerAlwaysGoesStraightWhenStraightIsAvailable() {
        val rig = liveRig(seed = 9L)
        rig.approachStraightChoice()
        val initialHeading = rig.game.heading
        val decisions = rig.game.choiceDecisions
        var guard = 0
        while (rig.game.choiceDecisions == decisions && guard++ < 100) rig.tick(controller = GhoulRunControllerInput())
        assertTrue(rig.game.choiceDecisions > decisions)
        assertEquals(0, rig.game.choiceTurns)
        assertEquals(initialHeading, rig.game.heading)
        assertEquals(GhoulLane.Center, rig.session.lane)
    }

    @Test
    fun controllerPressOutsideAChoiceCannotBeCarriedToALaterFork() {
        val rig = liveRig(seed = 9L)
        val game = rig.game
        var found = false
        for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val cell = MazeCell(row, col)
            for (heading in MazeDirection.entries) {
                if (!game.world.isOpen(cell, heading)) continue
                val next = cell.moved(heading)
                if (game.world.exits(next).count { it != heading.opposite } >= 2) continue
                game.placeRider(cell, heading, 0.15f)
                found = true
                break
            }
            if (found) break
        }
        assertTrue(found)
        rig.tick(controller = GhoulRunControllerInput(leftPressed = true))
        assertEquals(GhoulLane.Center, rig.session.lane)
        rig.approachStraightChoice()
        repeat(100) { rig.tick(controller = GhoulRunControllerInput()) }
        assertEquals(GhoulLane.Center, rig.session.lane)
        assertEquals(0, rig.game.choiceTurns)
    }

    @Test
    fun anArmedControllerTurnExpiresWhenTheRiderStops() {
        val rig = liveRig(seed = 9L)
        rig.approachStraightChoice()
        rig.tick(controller = GhoulRunControllerInput(leftPressed = true), rpm = 0)
        assertEquals(GhoulLane.Left, rig.session.lane)
        repeat(100) { rig.tick(controller = GhoulRunControllerInput(), rpm = 0) }
        assertEquals(GhoulLane.Center, rig.session.lane)
        assertEquals(0, rig.game.choiceTurns)
        val arrival = rig.game.heading
        val selected = rig.game.choiceDecisions
        var guard = 0
        while (rig.game.choiceDecisions == selected && guard++ < 200) rig.tick(controller = GhoulRunControllerInput())
        assertTrue(rig.game.choiceDecisions > selected)
        assertEquals(arrival, rig.game.heading)
        assertEquals(0, rig.game.choiceTurns)
    }

    @Test
    fun expiredControllerTurnCannotRemainLockedAtBlockedStraight() {
        val rig = liveRig(seed = 9L)
        rig.approachBlockedForkWithLeft()
        rig.tick(controller = GhoulRunControllerInput(leftPressed = true), rpm = 0)
        assertEquals(GhoulLane.Left, rig.session.lane)
        repeat(105) { rig.tick(controller = GhoulRunControllerInput(), rpm = 0) }
        assertEquals(GhoulLane.Center, rig.session.lane)
        var guard = 0
        while (!rig.game.waitingForChoice && guard++ < 250) rig.tick(controller = GhoulRunControllerInput())
        assertTrue(rig.game.waitingForChoice)
        assertEquals(0, rig.game.choiceTurns)
        assertEquals(GhoulLane.Center, rig.session.lane)
    }

    @Test
    fun controllerReverseClearsArmedTurnAndDoesNotRepeatOnIdleFrames() {
        val rig = liveRig(seed = 9L)
        val idle = GhoulRunControllerInput()
        repeat(10) { rig.tick(controller = idle) }
        rig.approachLeftChoice()
        val direction = rig.game.heading
        rig.tick(controller = GhoulRunControllerInput(leftPressed = true))
        assertEquals(GhoulLane.Left, rig.session.lane)
        rig.tick(controller = GhoulRunControllerInput(reversePressed = true))
        assertEquals(direction.opposite, rig.game.heading)
        assertEquals(GhoulLane.Center, rig.session.lane)
        rig.tick(controller = idle)
        assertEquals(direction.opposite, rig.game.heading)
    }

    @Test
    fun analogStickReleaseDoesNotDiscardARecentNearbyTurn() {
        val rig = liveRig(seed = 9L)
        rig.approachStraightChoice()
        rig.tick(controller = GhoulRunControllerInput(stickX = -1f))
        assertEquals(GhoulLane.Left, rig.session.lane)
        rig.tick(controller = GhoulRunControllerInput(stickX = 0f))
        assertEquals(GhoulLane.Left, rig.session.lane)
        repeat(110) { rig.tick(controller = GhoulRunControllerInput()) }
        assertEquals(GhoulLane.Center, rig.session.lane)
    }

    @Test
    fun controllerStickDriftBelowSteeringThresholdCannotTurn() {
        val rig = liveRig(seed = 9L)
        rig.approachStraightChoice()
        repeat(110) { rig.tick(controller = GhoulRunControllerInput(stickX = 0.17f)) }
        assertEquals(GhoulLane.Center, rig.session.lane)
        assertEquals(0, rig.game.choiceTurns)
    }

}
