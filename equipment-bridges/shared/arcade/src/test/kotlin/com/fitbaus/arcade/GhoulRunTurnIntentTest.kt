// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

internal class GhoulRunTurnIntentTest {
    private val ms = 1_000_000L

    private class Rig(val game: GhoulRunGame, val session: GhoulRunSession, var now: Long) {
        fun tick(faceX: Float = 0.5f, input: GhoulRunControllerInput? = null) {
            now += 33_000_000L
            val usingController = input != null
            session.update(
                HandPosition(faceX, 0.5f, 1f, now, if (usingController) HandSource.Lost else HandSource.Camera),
                if (usingController) CameraState.Unavailable else CameraState.Ready,
                true,
                true,
                70,
                true,
                "turn-$now",
                now,
                source = if (usingController) GhoulRunInputSource.Controller else GhoulRunInputSource.Webcam,
                controllerAvailable = usingController,
                controller = input,
            )
        }
    }

    private fun doubleLeftFixture(): Pair<Long, Pair<MazeCell, MazeDirection>> {
        for (seed in 1L..64L) {
            val world = GhoulRunWorld(seed = seed)
            for (row in 0 until world.config.height) for (col in 0 until world.config.width) {
                val first = MazeCell(row, col)
                for (incoming in MazeDirection.entries) {
                    val direction = incoming.relativeLeft
                    val second = first.moved(direction)
                    if (!world.contains(second) || !world.isOpen(first, incoming.opposite)) continue
                    if (!world.isOpen(first, direction)) continue
                    val firstOptions = world.exits(first).filter { it != incoming.opposite }
                    val secondOptions = world.exits(second).filter { it != direction.opposite }
                    if (firstOptions.size >= 2 && secondOptions.size >= 2 && direction.relativeLeft in secondOptions) {
                        return seed to (first to incoming)
                    }
                }
            }
        }
        error("no double-left fixture")
    }

    private fun rigFor(seed: Long, first: MazeCell, incoming: MazeDirection, controller: Boolean): Rig {
        val config = GhoulRunConfig()
        val pace = GhoulPace(config)
        var now = 1_000_000_000L
        repeat(((config.warmupSeconds + 0.5f) * 10f).toInt()) {
            now += 100 * ms
            pace.update(true, true, 70, true, "warm-$now", now)
            pace.advanceWarmup()
        }
        val game = GhoulRunGame(config, seed)
        game.step(config.step, GhoulLane.Center, 0f, 70f, 70f)
        game.skipLeanCheck()
        game.ghoul.state = GhoulState.Inactive
        val rig = Rig(game, GhoulRunSession(game, pace = pace), now)
        repeat(50) { rig.tick(input = if (controller) GhoulRunControllerInput() else null) }
        game.placeRider(first.moved(incoming.opposite), incoming, 0.05f)
        return rig
    }

    @Test
    fun boundedBufferTargetsAdjacentJunctionsAndExpires() {
        val (seed, fixture) = doubleLeftFixture()
        val (first, incoming) = fixture
        val rig = rigFor(seed, first, incoming, controller = true)
        val buffer = GhoulTurnIntentBuffer()
        val now = rig.now
        buffer.offer(rig.game, GhoulLane.Left, now)
        buffer.offer(rig.game, GhoulLane.Left, now + ms)
        assertEquals(GhoulLane.Left, buffer.current)
        assertEquals(2, buffer.size)
        buffer.offer(rig.game, GhoulLane.Center, now + 2 * ms)
        assertEquals(2, buffer.size)
        buffer.consume()
        rig.game.placeRider(first, incoming.relativeLeft, 0f)
        buffer.refresh(rig.game, now + 3 * ms)
        assertEquals(GhoulLane.Left, buffer.current)
        buffer.refresh(rig.game, now + 3_000 * ms)
        assertEquals(null, buffer.current)
        assertEquals(0, buffer.size)
    }

    @Test
    fun oneContinuousWebcamLeanTakesTwoConsecutiveLeftTurns() {
        val (seed, fixture) = doubleLeftFixture()
        val (first, incoming) = fixture
        val rig = rigFor(seed, first, incoming, controller = false)
        val initial = rig.game.choiceTurns
        var count = 0
        while (rig.game.choiceTurns - initial < 2 && count++ < 150) rig.tick(faceX = 0.15f)
        assertEquals(2, rig.game.choiceTurns - initial)
        assertEquals(incoming.opposite, rig.game.heading)
        assertEquals(GhoulLane.Left, rig.session.lane)
    }

    @Test
    fun quickControllerLeftLeftTakesTwoConsecutiveJunctions() {
        val (seed, fixture) = doubleLeftFixture()
        val (first, incoming) = fixture
        val rig = rigFor(seed, first, incoming, controller = true)
        val initial = rig.game.choiceTurns
        rig.tick(input = GhoulRunControllerInput(leftPressed = true))
        rig.tick(input = GhoulRunControllerInput(leftPressed = true))
        var count = 0
        while (rig.game.choiceTurns - initial < 2 && count++ < 150) rig.tick(input = GhoulRunControllerInput())
        assertEquals(2, rig.game.choiceTurns - initial)
        assertEquals(incoming.opposite, rig.game.heading)
        assertEquals(GhoulLane.Center, rig.session.lane)
    }

    @Test
    fun twoControllerTapsDeliveredInOneFrameStillTakeTwoTurns() {
        val (seed, fixture) = doubleLeftFixture()
        val (first, incoming) = fixture
        val rig = rigFor(seed, first, incoming, controller = true)
        val initial = rig.game.choiceTurns
        rig.tick(input = GhoulRunControllerInput(leftPressed = true, leftPressCount = 2))
        var count = 0
        while (rig.game.choiceTurns - initial < 2 && count++ < 150) rig.tick(input = GhoulRunControllerInput())
        assertEquals(2, rig.game.choiceTurns - initial)
        assertEquals(incoming.opposite, rig.game.heading)
    }

    @Test
    fun distinctAnalogGesturesAreBufferedWithoutAutoRepeatingTheHold() {
        val (seed, fixture) = doubleLeftFixture()
        val (first, incoming) = fixture
        val rig = rigFor(seed, first, incoming, controller = true)
        val initial = rig.game.choiceTurns
        rig.tick(input = GhoulRunControllerInput(stickX = -1f))
        rig.tick(input = GhoulRunControllerInput(stickX = 0f))
        rig.tick(input = GhoulRunControllerInput(stickX = -1f))
        var count = 0
        while (rig.game.choiceTurns - initial < 2 && count++ < 150) rig.tick(input = GhoulRunControllerInput(stickX = -1f))
        assertEquals(2, rig.game.choiceTurns - initial)
        assertEquals(incoming.opposite, rig.game.heading)
        assertEquals(GhoulLane.Center, rig.session.lane)
    }

    @Test
    fun lateTurnOverridesPreviouslyPreviewedStraightDirection() {
        val game = GhoulRunGame(seed = 13L)
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        game.skipLeanCheck()
        game.ghoul.state = GhoulState.Inactive
        var found: Pair<MazeCell, MazeDirection>? = null
        outer@ for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val junction = MazeCell(row, col)
            for (incoming in MazeDirection.entries) {
                if (game.world.isOpen(junction, incoming.opposite) &&
                    game.world.isOpen(junction, incoming) &&
                    game.world.isOpen(junction, incoming.relativeLeft)
                ) {
                    found = junction to incoming
                    break@outer
                }
            }
        }
        val (junction, incoming) = checkNotNull(found)
        game.placeRider(junction.moved(incoming.opposite), incoming, 0.72f)
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        assertEquals(incoming, game.activeChoice)
        game.step(game.config.step, GhoulLane.Left, -1f, 70f, 70f)
        assertEquals(incoming.relativeLeft, game.activeChoice)
        repeat(50) {
            if (game.riderCell != junction) game.step(game.config.step, GhoulLane.Left, -1f, 70f, 70f)
        }
        assertEquals(junction, game.riderCell)
        assertEquals(incoming.relativeLeft, game.heading)
    }

    @Test
    fun decisionCounterAdvancesWhenTheRiderGoesStraightAtARealFork() {
        val game = GhoulRunGame(seed = 13L)
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        game.skipLeanCheck()
        game.ghoul.state = GhoulState.Inactive
        var found: Pair<MazeCell, MazeDirection>? = null
        outer@ for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val junction = MazeCell(row, col)
            for (incoming in MazeDirection.entries) {
                if (game.world.isOpen(junction, incoming.opposite) &&
                    game.world.isOpen(junction, incoming) &&
                    game.world.isOpen(junction, incoming.relativeLeft)
                ) {
                    found = junction to incoming
                    break@outer
                }
            }
        }
        val (junction, incoming) = checkNotNull(found)
        game.placeRider(junction.moved(incoming.opposite), incoming, 0.85f)
        val before = game.choiceDecisions
        repeat(50) {
            if (game.riderCell != junction) game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        }
        assertEquals(before + 1, game.choiceDecisions)
        assertEquals(incoming, game.heading)
        assertTrue(game.choiceTurns == 0)
    }
}
