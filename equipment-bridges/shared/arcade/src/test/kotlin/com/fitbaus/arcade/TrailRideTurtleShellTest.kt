// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TrailRideTurtleShellTest {
    private fun newRide(kind: ObstacleKind): Pair<TrailRideGame, TrailObstacle> {
        val config = TrailRideConfig(world = TrailWorlds.straight(firstDitch = TrailWorlds.NEVER))
        val game = TrailWorlds.riding(config)
        val shell = TrailObstacle(
            id = -1, group = -1, distance = 24f, offset = 0f,
            x = 0f, radius = config.world.rockRadius, kind = kind,
        )
        game.world.obstacles.add(shell)
        return game to shell
    }

    private fun cross(game: TrailRideGame, obstacle: TrailObstacle, jump: Boolean, steer: Float = 0f) {
        var requested = false
        var steps = 0
        while (!obstacle.resolved && steps++ < 1000) {
            if (jump && !requested &&
                obstacle.distance - game.distance <= game.speed * game.config.hopAirSeconds * 0.48f
            ) {
                game.requestJump()
                requested = true
            }
            game.step(game.config.step, steer, 70f)
        }
        assertTrue(obstacle.resolved, "obstacle should have been reached")
        if (jump) assertTrue(requested)
    }

    @Test
    fun groundCollisionWithShellHasTheShorterRecovery() {
        val (game, shell) = newRide(ObstacleKind.TurtleShell)
        cross(game, shell, jump = false)
        assertTrue(shell.hit)
        assertEquals(1, game.obstacleHits)
        assertEquals(1, game.crashes)
        assertEquals(TrailCrash.Obstacle, game.lastCrash)
        assertEquals(TrailPhase.Crashed, game.phase)
        assertEquals(0.6f, game.config.crashSeconds, 0.0001f)
        game.step(0.25f, 0f, 70f)
        assertEquals(TrailPhase.Crashed, game.phase)
        val frozen = game.distance
        game.step(0.36f, 0f, 70f)
        assertEquals(TrailPhase.Riding, game.phase)
        assertEquals(frozen, game.distance, 0.0001f)
    }

    @Test
    fun ordinaryHopClearsTheShellAndAwardsAnAvoidance() {
        val (game, shell) = newRide(ObstacleKind.TurtleShell)
        assertTrue(game.config.hopHeight > game.config.turtleShellClearHeight)
        cross(game, shell, jump = true)
        assertFalse(shell.hit)
        assertEquals(0, game.crashes)
        assertEquals(0, game.obstacleHits)
        assertEquals(1, game.dodged)
        assertEquals(JumpResult.Hop, game.lastJump)
        assertEquals(TrailPhase.Riding, game.phase)
    }

    @Test
    fun steeringAroundTheShellStillWorks() {
        val (game, shell) = newRide(ObstacleKind.TurtleShell)
        cross(game, shell, jump = false, steer = 0.35f)
        assertFalse(shell.hit)
        assertEquals(0, game.crashes)
        assertEquals(1, game.dodged)
        assertEquals(TrailPhase.Riding, game.phase)
    }

    @Test
    fun onlyTurtleShellsCanBeClearedByOrdinaryHops() {
        for (kind in listOf(ObstacleKind.Rock, ObstacleKind.Trunk)) {
            val (game, obstacle) = newRide(kind)
            cross(game, obstacle, jump = true)
            assertTrue(obstacle.hit, "$kind should retain its existing collision behavior")
            assertEquals(1, game.crashes)
        }
    }

    private fun generated(config: TrailWorldConfig, seed: Long): List<TrailObstacle> {
        val world = TrailRideWorld(config, seed)
        val all = LinkedHashMap<Int, TrailObstacle>()
        var distance = 0f
        while (distance <= 6000f) {
            world.ensure(distance)
            for (o in world.obstacles) all[o.id] = o
            world.trim(distance)
            distance += 10f
        }
        return all.values.toList()
    }

    @Test
    fun shellsAreOccasionalSeededSubstitutesNotExtraHazards() {
        val config = TrailWorldConfig(firstDitchAt = TrailWorlds.NEVER)
        val default = generated(config, 33L)
        val without = generated(config.copy(turtleShellChance = 0f), 33L)
        val allShells = generated(config.copy(turtleShellChance = 1f), 33L)
        val turtles = default.filter { it.kind == ObstacleKind.TurtleShell }
        assertTrue(turtles.size >= 5, "occasional shells should appear on a long ride")
        assertTrue(turtles.size < default.size / 4, "shells should remain uncommon")
        assertEquals(without.size, default.size)
        assertEquals(default.size, allShells.size)
        assertEquals(
            without.map { listOf(it.id, it.group, it.distance, it.offset, it.x, it.radius) },
            default.map { listOf(it.id, it.group, it.distance, it.offset, it.x, it.radius) },
        )
        assertTrue(without.none { it.kind == ObstacleKind.TurtleShell })
        assertTrue(allShells.none { it.kind == ObstacleKind.Rock })
        assertTrue(turtles.all { it.radius == config.rockRadius })
        assertTrue(turtles.all { kotlin.math.abs(it.offset) <= 0.55f })
    }
}
