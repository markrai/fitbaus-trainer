// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GhoulRunGameTest {
    private fun run(
        game: GhoulRunGame,
        seconds: Float,
        lane: GhoulLane = GhoulLane.Center,
        lean: Float = 0f,
        rpm: Float = 70f,
        baseline: Float = 70f,
    ) {
        repeat((seconds / game.config.step).toInt()) {
            game.step(game.config.step, lane, lean, rpm, baseline)
        }
    }

    private fun activate(game: GhoulRunGame) {
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        assertEquals(GhoulPhase.LeanCheck, game.phase)
        game.skipLeanCheck()
        assertEquals(GhoulPhase.Playing, game.phase)
    }

    private fun findArrival(
        game: GhoulRunGame,
        predicate: (MazeCell, MazeDirection, List<MazeDirection>) -> Boolean,
    ): Pair<MazeCell, MazeDirection> {
        for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val cell = MazeCell(row, col)
            for (arrival in MazeDirection.entries) {
                if (!game.world.isOpen(cell, arrival.opposite)) continue
                val allowed = game.world.exits(cell).filter { it != arrival.opposite }
                if (predicate(cell, arrival, allowed)) return cell to arrival
            }
        }
        error("no matching junction")
    }

    @Test
    fun cadenceMapsSpeedAndRadiiAndStopsBelowTwenty() {
        val game = GhoulRunGame(seed = 3L)
        assertEquals(0f, game.speedFor(19.9f, 70f))
        assertEquals(game.config.creepSpeed, game.speedFor(55f, 70f), 1e-5f)
        assertEquals(game.config.cruiseSpeed, game.speedFor(70f, 70f), 1e-5f)
        assertEquals(game.config.sprintSpeed, game.speedFor(90f, 70f), 1e-5f)
        assertEquals(0f to 0f, game.radiiFor(19.9f, 70f))
        assertEquals(game.config.creepLightRadius, game.radiiFor(55f, 70f).first, 1e-5f)
        assertEquals(game.config.sprintNoiseRadius, game.radiiFor(90f, 70f).second, 1e-5f)
    }

    @Test
    fun warmupHoldsTheRiderStillAndGhoulSleepsUntilGo() {
        val game = GhoulRunGame(seed = 2L)
        val startCell = game.riderCell
        val startHeading = game.heading
        run(game, 30f, lane = GhoulLane.Left, lean = -1f, rpm = 100f, baseline = Float.NaN)
        assertEquals(GhoulPhase.WarmUp, game.phase)
        assertEquals(GhoulState.Inactive, game.ghoul.state)
        assertEquals(0f, game.speed)
        assertEquals(startCell, game.riderCell)
        assertEquals(startHeading, game.heading)
        assertEquals(0f, game.progress)
        assertTrue(game.lightRadius > 0f, "the start must stay lit during warm-up")
        assertTrue(game.warmupTime >= 29.9f)

        val hold = game.config.leanCheckHoldSeconds + game.config.leanCheckConfirmSeconds + 0.05f
        run(game, 0.05f, lane = GhoulLane.Center)
        assertEquals(GhoulPhase.LeanCheck, game.phase)
        assertEquals(GhoulLane.Left, game.leanCheckTarget)
        run(game, hold, lane = GhoulLane.Right)
        assertEquals(GhoulLane.Left, game.leanCheckTarget, "the wrong side does not pass the check")
        run(game, hold, lane = GhoulLane.Left)
        assertEquals(GhoulLane.Right, game.leanCheckTarget)
        run(game, hold, lane = GhoulLane.Right)
        assertEquals(GhoulLane.Center, game.leanCheckTarget)
        run(game, hold, lane = GhoulLane.Center)
        assertEquals(null, game.leanCheckTarget)
        assertEquals(GhoulPhase.LeanCheck, game.phase, "GO is shown before the ghoul wakes")
        assertEquals(GhoulState.Inactive, game.ghoul.state)
        assertEquals(startCell, game.riderCell)
        assertEquals(0f, game.progress)
        run(game, game.config.leanCheckGoSeconds + 0.05f)
        assertEquals(GhoulPhase.Playing, game.phase)
        assertEquals(GhoulState.Wandering, game.ghoul.state)
        assertEquals(game.world.start, game.riderCell)
    }

    @Test
    fun leanCheckRunsOnlyForTheFirstMaze() {
        val game = GhoulRunGame(seed = 2L)
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        assertEquals(GhoulPhase.LeanCheck, game.phase)
        game.skipLeanCheck()
        assertTrue(game.leanCheckPassed)
        game.visitForTest(game.world.exit)
        assertEquals(GhoulPhase.Results, game.phase)
        run(game, game.config.resultsSeconds + game.config.restartCountdownSeconds + 0.1f)
        assertEquals(GhoulPhase.Playing, game.phase, "the next maze starts without another lean check")
        assertEquals(GhoulState.Wandering, game.ghoul.state)
        assertTrue(game.leanCheckPassed)

        game.restart()
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        assertEquals(GhoulPhase.Playing, game.phase, "a maze restart skips it too")
        val fresh = GhoulRunGame(seed = 3L)
        fresh.markLeanCheckPassed()
        fresh.step(fresh.config.step, GhoulLane.Center, 0f, 70f, 70f)
        assertEquals(GhoulPhase.Playing, fresh.phase, "a replacement game inherits the passed check")
    }

    @Test
    fun riderRelativeSelectionsForAllHeadings() {
        val game = GhoulRunGame(seed = 11L)
        for (heading in MazeDirection.entries) {
            val found = findArrival(game) { _, arrival, allowed ->
                arrival == heading && heading in allowed && heading.relativeLeft in allowed && heading.relativeRight in allowed
            }
            assertEquals(heading.relativeLeft, game.choiceFor(found.first, heading, GhoulLane.Left))
            assertEquals(heading, game.choiceFor(found.first, heading, GhoulLane.Center))
            assertEquals(heading.relativeRight, game.choiceFor(found.first, heading, GhoulLane.Right))
        }
        val south = findArrival(game) { _, arrival, allowed ->
            arrival == MazeDirection.South && MazeDirection.East in allowed && MazeDirection.West in allowed
        }
        assertEquals(MazeDirection.East, game.choiceFor(south.first, MazeDirection.South, GhoulLane.Left))
        assertEquals(MazeDirection.West, game.choiceFor(south.first, MazeDirection.South, GhoulLane.Right))
    }

    @Test
    fun turnSlotsAppearOnlyForRealChoices() {
        val game = GhoulRunGame(seed = 13L)
        activate(game)
        val (junction, arrival) = findArrival(game) { _, direction, allowed ->
            direction in allowed && direction.relativeLeft in allowed && direction.relativeRight !in allowed
        }
        game.placeRider(junction.moved(arrival.opposite), arrival, 0.2f)
        game.step(0.001f, GhoulLane.Left, -1f, 0f, 70f)
        val slots = checkNotNull(game.turnSlots())
        assertTrue(slots.left && slots.straight && !slots.right)
        assertEquals(GhoulLane.Left, slots.selected)

        val (corner, cornerArrival) = findArrival(game) { _, _, allowed -> allowed.size == 1 }
        game.placeRider(corner.moved(cornerArrival.opposite), cornerArrival, 0.2f)
        game.step(0.001f, GhoulLane.Left, -1f, 0f, 70f)
        assertEquals(null, game.turnSlots())
    }

    @Test
    fun blockedStraightWaitsForAConsciousChoice() {
        val game = GhoulRunGame(seed = 18L)
        activate(game)
        game.ghoul.state = GhoulState.Inactive
        val (junction, arrival) = findArrival(game) { _, direction, allowed ->
            direction !in allowed && allowed.size >= 2
        }
        val before = junction.moved(arrival.opposite)
        game.placeRider(before, arrival, 0.51f)
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        assertTrue(game.brakingForChoice)
        assertEquals(GhoulHint.ChooseTurn, game.hint())
        assertEquals(null, game.activeChoice, "nothing is pre-selected for the player")
        run(game, 6f, lane = GhoulLane.Center)
        assertEquals(junction, game.riderCell, "the rider rides up to the junction")
        assertTrue(game.waitingForChoice)
        assertEquals(arrival, game.heading, "and stops there without turning")
        assertEquals(0f, game.speed)
        assertEquals(0, game.choiceTurns)
        assertEquals(GhoulHint.ChooseTurn, game.hint())
        val slots = checkNotNull(game.turnSlots())
        assertFalse(slots.straight)
        assertEquals(null, slots.selected)

        val side = if (arrival.relativeLeft in game.world.exits(junction)) GhoulLane.Left else GhoulLane.Right
        val expected = if (side == GhoulLane.Left) arrival.relativeLeft else arrival.relativeRight
        // Leaning towards a closed side still chooses nothing.
        val closed = if (side == GhoulLane.Left) GhoulLane.Right else GhoulLane.Left
        val closedDirection = if (closed == GhoulLane.Left) arrival.relativeLeft else arrival.relativeRight
        if (closedDirection !in game.world.exits(junction)) {
            run(game, 1f, lane = closed)
            assertTrue(game.waitingForChoice)
        }
        run(game, 0.5f, lane = side)
        assertFalse(game.waitingForChoice)
        assertEquals(expected, game.heading)
        assertEquals(1, game.choiceTurns)
    }

    @Test
    fun deadEndTurnTakesPointSixSeconds() {
        val deadGame = GhoulRunGame(seed = 5L)
        activate(deadGame)
        val (dead, arrival) = findArrival(deadGame) { _, _, allowed -> allowed.isEmpty() }
        deadGame.placeRider(dead.moved(arrival.opposite), arrival, 0.99f)
        run(deadGame, 0.2f)
        assertTrue(deadGame.turningLeft > 0f)
        run(deadGame, deadGame.config.deadEndTurnSeconds + 0.05f)
        assertEquals(arrival.opposite, deadGame.heading)
    }

    @Test
    fun fullLeanHeldTenSecondsNeverReversesTheRider() {
        for ((lane, lean) in listOf(GhoulLane.Left to -1f, GhoulLane.Right to 1f)) {
            val still = GhoulRunGame(seed = 9L)
            activate(still)
            val initial = still.heading
            run(still, 10f, lane = lane, lean = lean, rpm = 0f)
            assertEquals(initial, still.heading, "a held $lane lean must not U-turn a stopped rider")

            val moving = GhoulRunGame(seed = 9L)
            activate(moving)
            var previous = moving.heading
            var previousTurning = moving.turningLeft
            repeat((10f / moving.config.step).toInt()) {
                moving.step(moving.config.step, lane, lean, 70f, 70f)
                if (moving.heading == previous.opposite) {
                    assertTrue(previousTurning > 0f, "only a dead end may reverse the rider ($lane)")
                }
                previous = moving.heading
                previousTurning = moving.turningLeft
            }
        }
    }

    @Test
    fun gaugeMarksInvertTheConfiguredCurves() {
        val game = GhoulRunGame(seed = 3L)
        val config = game.config
        val baseline = 70f
        for (gap in listOf(config.creepNoiseRadius, 3f, 5f, 7.5f, config.sprintNoiseRadius)) {
            val marks = checkNotNull(game.gaugeMarks(baseline, gap))
            val ear = checkNotNull(marks.earRpm)
            assertEquals(gap, game.radiiFor(ear, baseline).second, 1e-3f, "ear for gap $gap")
            assertFalse(marks.earPinned)
        }
        val pinned = checkNotNull(game.gaugeMarks(baseline, config.creepNoiseRadius - 0.5f))
        assertTrue(pinned.earPinned)
        assertEquals(pinned.lowRpm, pinned.earRpm)
        assertEquals(baseline - config.baselineCreepDelta, pinned.lowRpm)
        assertEquals(baseline + config.sprintDelta, pinned.highRpm)
        val hidden = checkNotNull(game.gaugeMarks(baseline, config.sprintNoiseRadius + 0.5f))
        assertTrue(hidden.earHidden)
        assertEquals(null, game.gaugeMarks(Float.NaN, 4f))
        val outrun = hidden.outrunRpm
        assertEquals(game.ghoulHuntSpeed, game.speedFor(outrun, baseline), 1e-3f)
        assertTrue(game.speedFor(outrun + 1f, baseline) > game.ghoulHuntSpeed)
        val hard = GhoulRunGame(GhoulRunConfig(sprintDelta = 30f), seed = 3L)
        assertEquals(hard.ghoulHuntSpeed, hard.speedFor(checkNotNull(hard.gaugeMarks(80f, 4f)).outrunRpm, 80f), 1e-3f)
    }

    @Test
    fun bulkPathDistancesMatchPerCellDistances() {
        val game = GhoulRunGame(seed = 17L)
        activate(game)
        val out = FloatArray(game.config.width * game.config.height)
        repeat(40) {
            run(game, 0.37f)
            game.fillRiderPathDistances(out)
            for (index in out.indices) {
                val cell = MazeCell(index / game.config.width, index % game.config.width)
                assertEquals(game.riderPathDistanceTo(cell), out[index], 1e-4f, "$cell")
            }
        }
    }

    @Test
    fun choiceTurnsCountOnlyTurnsAtRealChoices() {
        val game = GhoulRunGame(seed = 13L)
        activate(game)
        game.ghoul.state = GhoulState.Inactive
        val (junction, arrival) = findArrival(game) { _, direction, allowed ->
            direction in allowed && direction.relativeLeft in allowed
        }
        game.placeRider(junction.moved(arrival.opposite), arrival, 0.6f)
        run(game, 0.6f, lane = GhoulLane.Center)
        assertEquals(0, game.choiceTurns, "going straight through a choice is not a turn")
        game.placeRider(junction.moved(arrival.opposite), arrival, 0.6f)
        run(game, 0.6f, lane = GhoulLane.Left)
        assertEquals(arrival.relativeLeft, game.heading)
        assertEquals(1, game.choiceTurns)
        val (corner, cornerArrival) = findArrival(game) { _, direction, allowed -> allowed.size == 1 && allowed[0] != direction }
        game.placeRider(corner.moved(cornerArrival.opposite), cornerArrival, 0.6f)
        run(game, 0.6f, lane = GhoulLane.Center)
        assertEquals(1, game.choiceTurns, "an automatic corner is not a choice")
    }

    @Test
    fun hintsFollowPriorityOrder() {
        val game = GhoulRunGame(seed = 14L)
        activate(game)
        val rider = game.riderCell
        val near = game.world.exits(rider).first().let(rider::moved)
        game.forceGhoul(near, game.world.exits(near).first(), state = GhoulState.Hunting)
        assertEquals(GhoulHint.PedalPastGhoul, game.hint())
        game.ghoul.state = GhoulState.Searching
        assertEquals(GhoulHint.StayQuiet, game.hint())
        game.ghoul.state = GhoulState.Wandering
        val (junction, arrival) = findArrival(game) { _, _, allowed -> allowed.size >= 2 }
        game.placeRider(junction.moved(arrival.opposite), arrival, 0.3f)
        assertEquals(GhoulHint.LeanToChoose, game.hint())
    }

    @Test
    fun hearingUsesMazePathDistanceNotStraightLine() {
        val game = GhoulRunGame(seed = 7L)
        activate(game)
        var separated: Pair<MazeCell, MazeCell>? = null
        for (row in 0 until game.config.height) for (col in 0 until game.config.width) {
            val cell = MazeCell(row, col)
            for (direction in listOf(MazeDirection.East, MazeDirection.South)) {
                val next = cell.moved(direction)
                if (!game.world.contains(next) || game.world.isOpen(cell, direction)) continue
                if ((game.world.pathDistance(cell, next) ?: 0) >= 9) separated = cell to next
            }
        }
        val (rider, monster) = checkNotNull(separated)
        game.placeRider(rider, game.world.exits(rider).first())
        game.forceGhoul(monster, game.world.exits(monster).first(), state = GhoulState.Wandering)
        assertEquals(1, rider.manhattan(monster))
        assertTrue((game.world.pathDistance(rider, monster) ?: 0) >= 9)
        game.step(0.001f, GhoulLane.Center, 0f, 70f, 70f)
        assertEquals(GhoulState.Wandering, game.ghoul.state)
    }

    @Test
    fun ghoulMovesSmoothlyAlongEdges() {
        val game = GhoulRunGame(seed = 4L)
        activate(game)
        val path = game.world.shortestPath(game.world.monsterSpawn, game.riderCell)
        val start = path.first()
        val direction = game.world.exits(start).first()
        game.forceGhoul(start, direction, state = GhoulState.Wandering)
        val originalCell = game.ghoul.cell
        game.step(0.1f, GhoulLane.Center, 0f, 0f, 70f)
        assertEquals(originalCell, game.ghoul.cell)
        assertTrue(game.ghoul.progress in 0.01f..0.99f)
    }

    @Test
    fun catchRequiresPhysicalContactAndKnockbackPreventsChains() {
        val game = GhoulRunGame(seed = 12L)
        activate(game)
        val cell = game.world.start
        val direction = game.world.exits(cell).first()
        game.placeRider(cell, direction, 0.50f)
        game.forceGhoul(cell, direction, 0.14f, GhoulState.Hunting)
        game.step(0.001f, GhoulLane.Center, 0f, 0f, 70f)
        assertEquals(0, game.catches)
        assertEquals(null, game.catchEvent)
        game.forceGhoul(cell, direction, 0.17f, GhoulState.Hunting)
        game.step(0.001f, GhoulLane.Center, 0f, 0f, 70f)
        assertEquals(1, game.catches)
        assertEquals(game.config.startingHearts - 1, game.hearts)
        val event = checkNotNull(game.catchEvent)
        assertEquals(GhoulCatchEvent(1, game.elapsed, game.config.startingHearts - 1, respawned = false), event)
        assertEquals(GhoulState.Stunned, game.ghoul.state)
        assertTrue(game.pathGap >= 3f)
        assertTrue(game.invulnerableLeft >= game.config.invulnerabilitySeconds - 0.01f)
        run(game, game.config.catchStunSeconds - 0.05f, rpm = 0f)
        assertEquals(1, game.catches)
        assertTrue(event === game.catchEvent, "a catch event is set exactly once")
    }

    @Test
    fun ghoulTransitionsWanderHuntSearchWander() {
        val game = GhoulRunGame(seed = 14L)
        activate(game)
        val rider = game.riderCell
        val near = game.world.exits(rider).first().let(rider::moved)
        game.forceGhoul(near, game.world.exits(near).first(), state = GhoulState.Wandering)
        game.step(0.01f, GhoulLane.Center, 0f, 70f, 70f)
        assertEquals(GhoulState.Hunting, game.ghoul.state)

        val far = game.world.distancesFrom(game.ghoul.cell).maxBy { it.value }.key
        game.placeRider(far, game.world.exits(far).first())
        run(game, game.config.loseContactSeconds + 0.1f, rpm = 0f)
        assertEquals(GhoulState.Searching, game.ghoul.state)
        game.ghoul.cell = game.ghoul.lastKnown
        game.ghoul.progress = 0f
        game.ghoul.heading = game.world.exits(game.ghoul.cell).first()
        run(game, game.config.searchWaitSeconds + 0.1f, rpm = 0f)
        assertEquals(GhoulState.Wandering, game.ghoul.state)
    }

    @Test
    fun shrinePulseStunsWithinFivePathTilesAndRespectsRecharge() {
        val game = GhoulRunGame(seed = 15L)
        activate(game)
        val shrine = game.world.shrines.first()
        game.placeRider(shrine, game.world.exits(shrine).first())
        game.forceGhoul(shrine, game.world.exits(shrine).first(), state = GhoulState.Hunting)
        game.visitForTest(shrine)
        assertEquals(shrine, game.checkpoint)
        assertEquals(GhoulState.Stunned, game.ghoul.state)
        assertEquals(game.config.shrineStunSeconds, game.ghoul.stunLeft)
        assertEquals(game.config.shrineRechargeSeconds, game.shrineCooldowns.getValue(shrine))

        game.ghoul.state = GhoulState.Hunting
        game.ghoul.stunLeft = 0f
        game.visitForTest(shrine)
        assertEquals(GhoulState.Hunting, game.ghoul.state, "a recharging shrine cannot pulse again")
    }

    @Test
    fun zeroHeartsRespawnsWithKeysAndResetsGhoul() {
        val game = GhoulRunGame(GhoulRunConfig(keyCount = 1), seed = 22L)
        activate(game)
        game.collectedKeys += game.world.keys.first()
        val events = ArrayList<GhoulCatchEvent>()
        repeat(game.config.startingHearts) {
            val cell = game.riderCell
            val direction = game.heading
            game.forceGhoul(cell, direction, game.progress, GhoulState.Hunting)
            game.step(0.001f, GhoulLane.Center, 0f, 0f, 70f)
            events += checkNotNull(game.catchEvent)
            if (it < game.config.startingHearts - 1) run(game, game.config.invulnerabilitySeconds + 0.1f, rpm = 0f)
        }
        assertEquals(listOf(2, 1, 0), events.map { it.heartsLeft })
        assertEquals(listOf(1, 2, 3), events.map { it.serial })
        assertEquals(listOf(false, false, true), events.map { it.respawned })
        assertEquals(0, game.hearts)
        assertTrue(game.respawnLeft > 0f, "out of hearts waits for the fade before moving")
        val caughtAt = game.riderCell to game.progress
        run(game, game.config.respawnSeconds - 0.1f, rpm = 90f)
        assertEquals(caughtAt, game.riderCell to game.progress)
        assertTrue(events.last() === game.catchEvent)
        run(game, 0.15f, rpm = 0f)
        assertEquals(1, game.respawns)
        assertTrue(game.invulnerableLeft > 0f)
        assertEquals(game.config.startingHearts, game.hearts)
        assertEquals(1, game.keysFound)
        assertEquals(game.checkpoint, game.riderCell)
        assertEquals(GhoulState.Wandering, game.ghoul.state)
    }

    @Test
    fun twentySeedPlayabilitySimulation() {
        val sprintResults = (1L..20L).map { simulate(it, sprintWhenHunted = true) }
        val cruiseResults = (1L..20L).map { simulate(it, sprintWhenHunted = false) }
        sprintResults.zip(cruiseResults).forEach { (sprint, cruise) ->
            println(
                "GHOUL_RUN seed=${sprint.seed} sprint_time=${"%.1f".format(sprint.seconds)} " +
                    "sprint_catches=${sprint.catches} cruise_time=${"%.1f".format(cruise.seconds)} " +
                    "cruise_catches=${cruise.catches}",
            )
            assertTrue(sprint.escaped && sprint.seconds < 240f, "sprint bot failed seed ${sprint.seed}: $sprint")
            assertTrue(sprint.catches <= 3, "too many sprint catches seed ${sprint.seed}: $sprint")
        }
        val sprintCatches = sprintResults.sumOf { it.catches }
        val cruiseCatches = cruiseResults.sumOf { it.catches }
        println("GHOUL_RUN totals sprint_catches=$sprintCatches cruise_catches=$cruiseCatches")
        assertTrue(
            cruiseCatches >= sprintCatches + 3 && cruiseCatches >= sprintCatches * 3 / 2,
            "never sprinting should be noticeably worse",
        )
    }

    @Test
    fun sprintAlwaysBreaksAOneTileHunt() {
        for (seed in 1L..20L) {
            val game = GhoulRunGame(seed = seed)
            val bot = CompassBot(recoverImmediately = true)
            activate(game)
            val path = game.world.shortestPath(game.world.start, game.world.exit)
            assertTrue(path.size >= 3)
            val riderDirection = directionBetween(path[1], path[2])
            game.placeRider(path[1], riderDirection)
            game.forceGhoul(path[0], directionBetween(path[0], path[1]), state = GhoulState.Hunting)
            var steps = 0
            // 15 s at the original 4 cells/s sprint; the window scales with speed so the distance is the same.
            val window = 15f * 4f / game.config.sprintSpeed
            while (steps < (window / game.config.step).toInt() &&
                game.ghoul.state == GhoulState.Hunting && game.phase != GhoulPhase.Results
            ) {
                val lane = bot.lane(game)
                game.step(
                    game.config.step,
                    lane,
                    0f,
                    70f + game.config.sprintDelta,
                    70f,
                )
                steps += 1
            }
            assertTrue(
                game.ghoul.state != GhoulState.Hunting || game.phase == GhoulPhase.Results,
                "seed $seed gap=${game.pathGap} state=${game.ghoul.state}",
            )
        }
    }

    private data class SimulationResult(
        val seed: Long,
        val escaped: Boolean,
        val seconds: Float,
        val catches: Int,
    )

    private fun simulate(seed: Long, sprintWhenHunted: Boolean): SimulationResult {
        val game = GhoulRunGame(seed = seed)
        val bot = CompassBot(recoverImmediately = true)
        repeat((240f / game.config.step).toInt()) {
            val hunted = game.ghoul.state == GhoulState.Hunting
            val rpm = if (sprintWhenHunted && hunted) 70f + game.config.sprintDelta else 70f
            game.step(game.config.step, bot.lane(game), 0f, rpm, 70f)
            game.skipLeanCheck()
            if (game.phase == GhoulPhase.Results) {
                return SimulationResult(seed, true, game.elapsed, game.catches)
            }
        }
        return SimulationResult(seed, false, game.elapsed, game.catches)
    }

    /** Follows the bearing first; after revisiting an approach, maze memory prevents a compass loop. */
    private class CompassBot(private val recoverImmediately: Boolean = false) {
        private val approachVisits = HashMap<Pair<MazeCell, MazeDirection>, Int>()
        private var approach: Pair<MazeCell, MazeDirection>? = null
        private var planned = GhoulLane.Center

        fun lane(game: GhoulRunGame): GhoulLane {
            val nextApproach = game.riderCell to game.heading
            if (nextApproach == approach) return planned
            approach = nextApproach
            val junction = game.riderCell.moved(game.heading)
            if (!game.world.contains(junction)) {
                planned = GhoulLane.Center
                return planned
            }
            val choices = game.world.exits(junction).filter { it != game.heading.opposite }
            if (choices.isEmpty()) {
                planned = GhoulLane.Center
                return planned
            }
            val visits = approachVisits[nextApproach] ?: 0
            approachVisits[nextApproach] = visits + 1
            val route = game.world.shortestPath(junction, game.world.exit)
            val routeDirection = route.getOrNull(1)?.let { next ->
                MazeDirection.entries.first { route[0].moved(it) == next }
            }
            val desired = if ((recoverImmediately || visits > 0 || game.ghoul.state == GhoulState.Hunting) && routeDirection in choices) {
                checkNotNull(routeDirection)
            } else {
                compassChoice(game, junction, game.heading)
            }
            planned = game.selectionFor(desired, junction, game.heading)
            return planned
        }
    }

    private fun directionBetween(from: MazeCell, to: MazeCell): MazeDirection =
        MazeDirection.entries.first { from.moved(it) == to }

    private companion object {
        /** Bot heuristic only: the exit-ward exit. The game itself never picks a direction for the player. */
        fun compassChoice(game: GhoulRunGame, cell: MazeCell, arrivalHeading: MazeDirection): MazeDirection {
            val allowed = game.world.exits(cell).filter { it != arrivalHeading.opposite }.ifEmpty { listOf(arrivalHeading.opposite) }
            return allowed.minWith(
                compareBy<MazeDirection> { direction ->
                    val next = cell.moved(direction)
                    val dr = next.row - game.world.exit.row
                    val dc = next.col - game.world.exit.col
                    dr * dr + dc * dc
                }.thenBy { if (it == arrivalHeading) 0 else 1 }.thenBy { it.ordinal },
            )
        }
    }
}
