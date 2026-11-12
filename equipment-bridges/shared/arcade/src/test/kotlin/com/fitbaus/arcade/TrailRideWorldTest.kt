// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.abs
import kotlin.math.max

class TrailRideWorldTest {
    private class Ride(val obstacles: List<TrailObstacle>, val ditches: List<TrailDitch>, val maxObstaclesHeld: Int, val maxDitchesHeld: Int, val maxPoints: Int)

    /** Walks a rider forward, generating and trimming like the game, and records every hazard ever made. */
    private fun ride(world: TrailRideWorld, to: Float, step: Float): Ride {
        val obstacles = LinkedHashMap<Int, TrailObstacle>()
        val ditches = LinkedHashMap<Int, TrailDitch>()
        var maxObstacles = 0
        var maxDitches = 0
        var maxPoints = 0
        var d = 0f
        while (d <= to) {
            world.ensure(d)
            world.center(d)
            for (o in world.obstacles) obstacles.putIfAbsent(o.id, o)
            for (x in world.ditches) ditches.putIfAbsent(x.id, x)
            world.trim(d)
            maxObstacles = max(maxObstacles, world.obstacles.size)
            maxDitches = max(maxDitches, world.ditches.size)
            maxPoints = max(maxPoints, world.pointsHeld)
            d += step
        }
        return Ride(obstacles.values.toList(), ditches.values.toList(), maxObstacles, maxDitches, maxPoints)
    }

    private fun signature(r: Ride): List<String> =
        r.obstacles.map { "o ${it.distance} ${it.x} ${it.radius} ${it.kind}" } + r.ditches.map { "d ${it.start} ${it.length}" }

    @Test
    fun sameSeedProducesTheSameTrailAndHazards() {
        val a = TrailRideWorld(seed = 42L)
        val b = TrailRideWorld(seed = 42L)
        for (i in 0..4000) assertEquals(a.center(i * 1.5f), b.center(i * 1.5f), "centre at ${i * 1.5f}")
        assertEquals(signature(ride(TrailRideWorld(seed = 42L), 6000f, 1f)), signature(ride(TrailRideWorld(seed = 42L), 6000f, 1f)))
    }

    @Test
    fun differentSeedsGenerateDifferentLayouts() {
        val a = TrailRideWorld(seed = 1L)
        val b = TrailRideWorld(seed = 2L)
        var differs = 0
        for (i in 0..200) if (abs(a.center(i * 10f) - b.center(i * 10f)) > 0.05f) differs += 1
        assertTrue(differs > 50, "centrelines should differ, got $differs differing samples")
        assertNotEquals(signature(ride(TrailRideWorld(seed = 1L), 3000f, 1f)), signature(ride(TrailRideWorld(seed = 2L), 3000f, 1f)))
    }

    @Test
    fun geometryDoesNotDependOnQueryRateOrOrder() {
        val fine = TrailRideWorld(seed = 9L)
        val coarse = TrailRideWorld(seed = 9L)
        val fineRide = ride(fine, 5000f, 0.13f)
        // Coarse rider also peeks far ahead first, as the renderer does.
        coarse.center(150f)
        val coarseRide = ride(coarse, 5000f, 7.3f)
        assertEquals(signature(fineRide), signature(coarseRide))
        val fresh = TrailRideWorld(seed = 9L)
        for (i in 0..300) {
            val d = 5000f + i
            assertEquals(fresh.center(d), coarse.center(d), 1e-5f, "centre at $d")
        }
    }

    @Test
    fun startsStraightThenBendsContinuouslyWithinBounds() {
        val world = TrailRideWorld(seed = 5L)
        val cfg = world.config
        for (d in 0..(cfg.straightStartPoints - 2) * cfg.segmentLength.toInt()) assertEquals(0f, world.center(d.toFloat()), 1e-6f)
        val step = 0.05f
        var previous = world.center(0f)
        var previousSlope = world.slope(0f)
        var maxJump = 0f
        var maxSlopeRatio = 0f
        var maxSlopeChange = 0f
        var maxOffset = 0f
        var d = step
        while (d < 12000f) {
            val c = world.center(d)
            val s = world.slope(d)
            maxJump = max(maxJump, abs(c - previous))
            maxSlopeChange = max(maxSlopeChange, abs(s - previousSlope))
            val cap = world.maxSlope(minOf(world.level(d) + 1, cfg.maxLevel))
            maxSlopeRatio = max(maxSlopeRatio, abs(s) / cap)
            maxOffset = max(maxOffset, abs(c))
            assertEquals((c - previous) / step, (s + previousSlope) / 2f, 0.01f, "slope matches the centreline at $d")
            previous = c
            previousSlope = s
            d += step
        }
        assertTrue(maxJump < 0.15f * step * 1.2f, "no jumps in path position (max step $maxJump)")
        assertTrue(maxSlopeChange < 0.002f, "no kinks: slope is continuous (max change $maxSlopeChange per ${step} m)")
        assertTrue(maxSlopeRatio <= 1.25f, "slope stays near the level cap (ratio $maxSlopeRatio)")
        assertTrue(maxOffset <= cfg.maxOffset * 1.15f, "lateral displacement bounded ($maxOffset)")
        assertTrue(maxOffset > cfg.maxOffset * 0.5f, "the trail actually wanders ($maxOffset)")
    }

    @Test
    fun curvatureIsBoundedAndTheTrailIsNotErratic() {
        val world = TrailRideWorld(seed = 77L)
        var maxCurvature = 0f
        var signChanges = 0
        var lastSign = 0
        var d = 0f
        while (d < 10000f) {
            val k = (world.slope(d + 0.5f) - world.slope(d - 0.5f)) / 1f
            maxCurvature = max(maxCurvature, abs(k))
            val sign = when {
                world.slope(d) > 0.01f -> 1
                world.slope(d) < -0.01f -> -1
                else -> 0
            }
            if (sign != 0 && lastSign != 0 && sign != lastSign) signChanges += 1
            if (sign != 0) lastSign = sign
            d += 1f
        }
        assertTrue(maxCurvature < 0.05f, "curvature bounded (max $maxCurvature 1/m)")
        assertTrue(signChanges < 10000f / 30f, "heading reverses no more than once per ~30 m on average ($signChanges)")
        assertTrue(signChanges > 20, "but the trail does weave left and right ($signChanges)")
    }

    @Test
    fun laterLevelsAreHarder() {
        val world = TrailRideWorld(seed = 3L)
        fun meanAbsSlope(from: Float, to: Float): Float {
            var sum = 0f
            var n = 0
            var d = from
            while (d < to) {
                sum += abs(world.slope(d))
                n += 1
                d += 2f
            }
            return sum / n
        }
        val cfg = world.config
        val early = meanAbsSlope(cfg.segmentLength * cfg.straightStartPoints, cfg.levelDistance)
        val late = meanAbsSlope(cfg.levelDistance * cfg.maxLevel, cfg.levelDistance * (cfg.maxLevel + 3))
        assertTrue(late > early * 1.3f, "level ${cfg.maxLevel} bends harder ($late vs $early)")
        val r = ride(TrailRideWorld(seed = 3L), cfg.levelDistance * (cfg.maxLevel + 2), 1f)
        val earlyGroups = r.obstacles.filter { it.distance < cfg.levelDistance }.groupBy { it.group }
        val lateGroups = r.obstacles.filter { it.distance > cfg.levelDistance * 2 }.groupBy { it.group }
        assertTrue(earlyGroups.values.all { it.size == 1 }, "level 1 has only single obstacles")
        assertTrue(lateGroups.values.any { it.size == 2 }, "later levels combine obstacles")
    }

    @Test
    fun obstaclesNeverSealTheTrail() {
        for (seed in 1L..12L) {
            val world = TrailRideWorld(seed = seed)
            val cfg = world.config
            var d = 0f
            while (d < 8000f) {
                world.ensure(d)
                for (o in world.obstacles) {
                    val gap = world.widestGap(o.distance, 0.5f)
                    assertTrue(gap >= cfg.minGap, "seed $seed: obstacle at ${o.distance} leaves only $gap m")
                    assertTrue(abs(o.offset) - o.radius < cfg.halfWidth, "seed $seed: obstacle at ${o.distance} is actually on the trail")
                    assertEquals(world.center(o.distance) + o.offset, o.x, 1e-4f)
                }
                world.trim(d)
                d += 20f
            }
        }
    }

    @Test
    fun hazardsKeepReactionDistanceAndDitchesHaveClearApproaches() {
        for (seed in 1L..12L) {
            val r = ride(TrailRideWorld(seed = seed), 12000f, 2f)
            val cfg = TrailWorldConfig()
            assertTrue(r.ditches.size >= 40, "seed $seed: ditches keep coming (${r.ditches.size})")
            assertTrue(r.ditches.first().start >= 200f, "first ditch comes after the rider has settled in")
            for (i in 1 until r.ditches.size) {
                assertTrue(r.ditches[i].start - r.ditches[i - 1].start >= cfg.minDitchSpacing, "seed $seed: ditch spacing")
            }
            for (o in r.obstacles) {
                for (x in r.ditches) {
                    assertTrue(o.distance <= x.start - cfg.ditchClearBefore || o.distance >= x.end + cfg.ditchClearAfter - 1e-3f, "seed $seed: obstacle ${o.distance} inside ditch ${x.start} clear zone")
                }
            }
            for (i in 1 until r.obstacles.size) {
                val a = r.obstacles[i - 1]
                val b = r.obstacles[i]
                assertTrue(b.distance >= a.distance, "obstacles are generated in order")
                if (a.group == b.group) {
                    assertTrue(b.distance - a.distance == 0f || b.distance - a.distance >= cfg.slalomGapMin, "seed $seed: grouped spacing")
                } else {
                    assertTrue(b.distance - a.distance >= cfg.minObstacleSpacing, "seed $seed: ${b.distance - a.distance} m between groups at ${a.distance}")
                }
            }
        }
    }

    @Test
    fun longRidesKeepBoundedCollections() {
        val world = TrailRideWorld(seed = 11L)
        val r = ride(world, 60000f, 0.5f)
        assertTrue(r.obstacles.size > 2500, "a long ride makes thousands of obstacles (${r.obstacles.size})")
        assertTrue(r.maxObstaclesHeld <= 20, "but only a window is held (${r.maxObstaclesHeld})")
        assertTrue(r.maxDitchesHeld <= 2, "ditches held ${r.maxDitchesHeld}")
        assertTrue(r.maxPoints <= TrailRideWorld.POINT_CAPACITY, "path points held ${r.maxPoints}")
        assertEquals(world.generatedObstacles, r.obstacles.size)
    }

    @Test
    fun resetRestartsTheSameSequence() {
        val world = TrailRideWorld(seed = 21L)
        val first = signature(ride(world, 2000f, 1f))
        world.reset(21L)
        assertEquals(first, signature(ride(world, 2000f, 1f)))
        world.reset(22L)
        assertNotEquals(first, signature(ride(world, 2000f, 1f)))
    }

    @Test
    fun sceneryHashIsStableAndUniform() {
        val world = TrailRideWorld(seed = 4L)
        assertEquals(world.scenery(123, 5), world.scenery(123, 5))
        var sum = 0.0
        for (i in 0 until 10000) {
            val v = world.scenery(i, 1)
            assertTrue(v >= 0f && v < 1f)
            sum += v
        }
        assertEquals(0.5, sum / 10000, 0.02)
    }

    @Test
    fun projectionScalesWithDepthAndMeetsTheHorizon() {
        val p = TrailProjection()
        assertEquals(1f, p.scale(0f), 1e-6f)
        assertEquals(0.5f, p.scale(p.focal), 1e-6f, "scale = focal / (z + focal)")
        var previous = Float.MAX_VALUE
        for (z in 0..200) {
            val y = p.groundY(z.toFloat())
            assertTrue(y < previous, "farther ground is higher on screen")
            assertTrue(y > p.horizonY)
            previous = y
            assertEquals(z.toFloat(), p.depthAt(y), 0.01f + z * 1e-4f, "depthAt inverts groundY")
        }
        assertEquals(p.horizonY + p.eyeHeight * p.pxPerMeter, p.groundY(0f), 1e-4f)
        assertTrue(p.groundY(10000f) - p.horizonY < 0.05f, "ground converges on the horizon")
        assertEquals(Float.POSITIVE_INFINITY, p.depthAt(p.horizonY))
    }

    @Test
    fun projectionIsSymmetricAndTheTrailNarrowsWithDistance() {
        val p = TrailProjection()
        val w = TrailWorldConfig().halfWidth
        assertEquals(p.width / 2f, p.screenX(0f, 30f), 1e-5f)
        assertEquals(p.width / 2f - (p.screenX(1f, 12f) - p.width / 2f), p.screenX(-1f, 12f), 1e-4f)
        assertTrue(p.screenX(-1f, 5f) < p.width / 2f, "negative world x (rider's left) draws on the left")
        val near = p.screenX(w, 2f) - p.screenX(-w, 2f)
        val far = p.screenX(w, 40f) - p.screenX(-w, 40f)
        assertEquals(near * p.scale(40f) / p.scale(2f), far, 1e-3f)
        assertTrue(far < near / 5f)
        assertEquals(p.size(2f, 10f), 2f * p.size(1f, 10f), 1e-5f)
        p.eyeHeight += 0.5f
        assertTrue(p.groundY(5f) > TrailProjection().groundY(5f), "a raised eye (jump) sees the ground lower on screen")
    }

    @Test
    fun cameraYawFollowsTheTrailSoAStraightDiagonalLooksStraight() {
        val p = TrailProjection()
        val slope = 0.1f
        val camX = 0.3f
        val start = 2f
        val lateral = (0..60).map { z -> p.lateral(start + slope * z, z.toFloat(), camX, slope) }
        for (v in lateral) assertEquals(start - camX, v, 1e-5f)
        assertTrue(abs(p.lateral(start + slope * 40f, 40f, camX, 0f) - (start - camX)) > 3f, "without yaw the same trail would sweep sideways")
    }
}
