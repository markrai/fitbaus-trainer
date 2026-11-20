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
    fun warmupUsesCruiseAndDoesNotSpawnGhoul() {
        val game = GhoulRunGame(seed = 2L)
        run(game, 30f, rpm = 100f, baseline = Float.NaN)
        assertEquals(GhoulPhase.WarmUp, game.phase)
        assertEquals(GhoulState.Inactive, game.ghoul.state)
        assertTrue(game.speed > game.config.creepSpeed)
        assertTrue(game.speed <= game.config.cruiseSpeed)
        activate(game)
        assertEquals(game.world.start, game.riderCell)
        assertEquals(GhoulState.Wandering, game.ghoul.state)
    }

    @Test
    fun screenSelectionsAndCenterStraightArePreserved() {
        val game = GhoulRunGame(seed = 11L)
        for (heading in MazeDirection.entries) {
            val left = game.world.screenTurn(heading, ScreenSide.Left)
            val right = game.world.screenTurn(heading, ScreenSide.Right)
            val found = findArrival(game) { _, arrival, allowed ->
                arrival == heading && heading in allowed && left in allowed && right in allowed
            }
            assertEquals(left, game.choiceFor(found.first, heading, GhoulLane.ScreenLeft))
            assertEquals(heading, game.choiceFor(found.first, heading, GhoulLane.Center))
            assertEquals(right, game.choiceFor(found.first, heading, GhoulLane.ScreenRight))
        }
    }

    @Test
    fun blockedStraightEasesToCreepThenTakesCompassTurn() {
        val game = GhoulRunGame(seed = 18L)
        activate(game)
        val (junction, arrival) = findArrival(game) { _, direction, allowed ->
            direction !in allowed && allowed.size >= 2
        }
        val before = junction.moved(arrival.opposite)
        val expected = game.compassChoice(junction, arrival)
        game.placeRider(before, arrival, 0.51f)
        game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
        assertTrue(game.brakingForChoice)
        assertTrue(game.speed > 0f, "an undecided junction must not stop the rider")
        var minimumWhileBraking = game.speed
        var steps = 0
        while (steps < 300 && game.riderCell != junction) {
            if (game.brakingForChoice) minimumWhileBraking = minOf(minimumWhileBraking, game.speed)
            game.step(game.config.step, GhoulLane.Center, 0f, 70f, 70f)
            steps += 1
        }
        assertTrue(minimumWhileBraking > 0f)
        assertEquals(junction, game.riderCell)
        assertEquals(expected, game.heading)
        assertFalse(game.brakingForChoice)
    }

    @Test
    fun deadEndTurnTakesPointSixSecondsAndHardLeanStillWorks() {
        val deadGame = GhoulRunGame(seed = 5L)
        activate(deadGame)
        val (dead, arrival) = findArrival(deadGame) { _, _, allowed -> allowed.isEmpty() }
        deadGame.placeRider(dead.moved(arrival.opposite), arrival, 0.99f)
        run(deadGame, 0.2f)
        assertTrue(deadGame.turningLeft > 0f)
        run(deadGame, deadGame.config.deadEndTurnSeconds + 0.05f)
        assertEquals(arrival.opposite, deadGame.heading)

        val leanGame = GhoulRunGame(seed = 9L)
        activate(leanGame)
        val initial = leanGame.heading
        run(leanGame, leanGame.config.hardLeanSeconds + 0.2f, lean = leanGame.config.hardLeanThreshold - 0.01f, rpm = 0f)
        assertEquals(initial, leanGame.heading)
        run(leanGame, leanGame.config.hardLeanSeconds + 0.05f, lean = 1f, rpm = 0f)
        assertEquals(initial.opposite, leanGame.heading)
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
        game.forceGhoul(cell, direction, 0.17f, GhoulState.Hunting)
        game.step(0.001f, GhoulLane.Center, 0f, 0f, 70f)
        assertEquals(1, game.catches)
        assertEquals(game.config.startingHearts - 1, game.hearts)
        assertEquals(GhoulState.Stunned, game.ghoul.state)
        assertTrue(game.pathGap >= 3f)
        assertTrue(game.invulnerableLeft >= game.config.invulnerabilitySeconds - 0.01f)
        run(game, game.config.catchStunSeconds - 0.05f, rpm = 0f)
        assertEquals(1, game.catches)
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
        repeat(game.config.startingHearts) {
            val cell = game.riderCell
            val direction = game.heading
            game.forceGhoul(cell, direction, game.progress, GhoulState.Hunting)
            game.step(0.001f, GhoulLane.Center, 0f, 0f, 70f)
            if (it < game.config.startingHearts - 1) run(game, game.config.invulnerabilitySeconds + 0.1f, rpm = 0f)
        }
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
    fun fifteenSecondSprintAlwaysBreaksAOneTileHunt() {
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
            while (steps < (15f / game.config.step).toInt() &&
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
                game.compassChoice(junction, game.heading)
            }
            planned = game.selectionFor(desired, junction, game.heading)
            return planned
        }
    }

    private fun directionBetween(from: MazeCell, to: MazeCell): MazeDirection =
        MazeDirection.entries.first { from.moved(it) == to }
}
