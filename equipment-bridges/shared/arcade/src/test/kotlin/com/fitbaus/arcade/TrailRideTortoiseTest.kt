// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TrailRideTortoiseTest {
    private fun newRide(kind: ObstacleKind, direction: Int = 1): Pair<TrailRideGame, TrailObstacle> {
        val config = TrailRideConfig(world = TrailWorlds.straight(firstDitch = TrailWorlds.NEVER))
        val game = TrailWorlds.riding(config)
        val tortoise = TrailObstacle(
            id = -1, group = -1, distance = 24f, offset = 0f,
            x = 0f, radius = config.world.rockRadius, kind = kind, crossingDirection = direction,
        )
        game.world.obstacles.add(tortoise)
        return game to tortoise
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
    fun groundCollisionWithTortoiseHasTheShorterRecovery() {
        val (game, tortoise) = newRide(ObstacleKind.Tortoise)
        cross(game, tortoise, jump = false)
        assertTrue(tortoise.hit)
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
    fun ordinaryHopClearsTheTortoiseAndAwardsAnAvoidance() {
        val (game, tortoise) = newRide(ObstacleKind.Tortoise)
        assertTrue(game.config.hopHeight > game.config.tortoiseClearHeight)
        cross(game, tortoise, jump = true)
        assertFalse(tortoise.hit)
        assertEquals(0, game.crashes)
        assertEquals(0, game.obstacleHits)
        assertEquals(1, game.dodged)
        assertEquals(JumpResult.Hop, game.lastJump)
        assertEquals(TrailPhase.Riding, game.phase)
    }

    @Test
    fun steeringAroundTheTortoiseStillWorks() {
        val (game, tortoise) = newRide(ObstacleKind.Tortoise)
        cross(game, tortoise, jump = false, steer = 0.35f)
        assertFalse(tortoise.hit)
        assertEquals(0, game.crashes)
        assertEquals(1, game.dodged)
        assertEquals(TrailPhase.Riding, game.phase)
    }

    @Test
    fun onlyTortoisesCanBeClearedByOrdinaryHops() {
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
    fun tortoisesAreOccasionalSeededSubstitutesNotExtraHazards() {
        val config = TrailWorldConfig(firstDitchAt = TrailWorlds.NEVER)
        val default = generated(config, 33L)
        val without = generated(config.copy(tortoiseChance = 0f), 33L)
        val allTortoises = generated(config.copy(tortoiseChance = 1f), 33L)
        val turtles = default.filter { it.kind == ObstacleKind.Tortoise }
        assertTrue(turtles.size >= 5, "occasional tortoises should appear on a long ride")
        assertTrue(turtles.size < default.size / 4, "tortoises should remain uncommon")
        assertEquals(without.size, default.size)
        assertEquals(default.size, allTortoises.size)
        assertEquals(
            without.map { listOf(it.id, it.group, it.distance, it.offset, it.x, it.radius) },
            default.map { listOf(it.id, it.group, it.distance, it.offset, it.x, it.radius) },
        )
        assertTrue(without.none { it.kind == ObstacleKind.Tortoise })
        assertTrue(allTortoises.none { it.kind == ObstacleKind.Rock })
        assertTrue(turtles.all { it.radius == config.rockRadius })
        assertTrue(turtles.all { kotlin.math.abs(it.offset) <= 0.55f })
        assertTrue(turtles.any { it.crossingDirection > 0 })
        assertTrue(turtles.any { it.crossingDirection < 0 })
    }
    @Test
    fun tortoiseCrossingMovesAcrossPathInBothDirections() {
        val halfWidth = TrailWorldConfig().halfWidth
        for (direction in listOf(-1, 1)) {
            val obstacle = TrailObstacle(9, 2, 100f, 0.15f, 0.15f, 0.28f, ObstacleKind.Tortoise, direction)
            val extent = halfWidth + TrailObstacle.CROSSING_MARGIN
            val lead = TrailObstacle.CROSSING_DISTANCE
            assertEquals(obstacle.x + direction * extent, obstacle.positionAt(obstacle.distance - lead, halfWidth), 0.0001f)
            assertEquals(obstacle.x, obstacle.positionAt(obstacle.distance, halfWidth), 0.0001f)
            assertEquals(obstacle.x - direction * extent, obstacle.positionAt(obstacle.distance + lead, halfWidth), 0.0001f)
            assertTrue(if (direction > 0) obstacle.positionAt(obstacle.distance - lead, halfWidth) >
                obstacle.positionAt(obstacle.distance + lead, halfWidth) else
                obstacle.positionAt(obstacle.distance - lead, halfWidth) <
                    obstacle.positionAt(obstacle.distance + lead, halfWidth))
        }
        val rock = TrailObstacle(2, 3, 100f, 0.3f, 0.3f, 0.28f, ObstacleKind.Rock)
        assertEquals(rock.x, rock.positionAt(71f, halfWidth))
        assertEquals(rock.x, rock.positionAt(100f, halfWidth))
    }

    @Test
    fun bothCrossingDirectionsRemainJumpableOrAvoidable() {
        for (direction in listOf(-1, 1)) {
            val (hopGame, tortoise) = newRide(ObstacleKind.Tortoise, direction)
            cross(hopGame, tortoise, jump = true)
            assertFalse(tortoise.hit)
            assertEquals(0, hopGame.crashes)
            assertEquals(1, hopGame.dodged)
            val (groundGame, groundTortoise) = newRide(ObstacleKind.Tortoise, direction)
            cross(groundGame, groundTortoise, jump = false)
            assertTrue(groundTortoise.hit)
            assertEquals(1, groundGame.crashes)
        }
    }

}
