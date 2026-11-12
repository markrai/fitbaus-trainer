// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.math.abs
import kotlin.random.Random

class TrailRideGameTest {
    private val step = TrailRideConfig().step

    private fun straightGame(firstDitch: Float = 90f, obstacles: Boolean = false, ditchSpacing: Float = 175f): TrailRideGame =
        TrailWorlds.riding(TrailRideConfig(world = TrailWorlds.straight(firstDitch, obstacles, ditchSpacing)))

    /** Rides to the first ditch, asks for a jump once it is [leadSeconds] away, and returns the game once it is resolved. */
    private fun jumpAt(leadSeconds: Float, steer: Float = 0f): TrailRideGame {
        val g = straightGame()
        val ditch = g.world.ditches.first()
        var requested = false
        var guard = 0
        while (!ditch.resolved && guard++ < 60 * 60) {
            if (!requested && g.timeTo(ditch) <= leadSeconds) {
                g.requestJump()
                requested = true
            }
            g.step(step, steer, 70f)
        }
        assertTrue(ditch.resolved, "the ditch was reached")
        return g
    }

    @Test
    fun speedFollowsCadenceWithinPlayableBounds() {
        val g = TrailRideGame()
        assertEquals(g.config.minSpeed, g.speedFor(0f))
        assertEquals(g.config.minSpeed, g.speedFor(40f))
        assertEquals(g.config.maxSpeed, g.speedFor(100f))
        assertEquals(g.config.maxSpeed, g.speedFor(220f), "no reward for extreme cadence")
        assertTrue(g.speedFor(80f) > g.speedFor(60f))
        assertTrue(g.config.maxSpeed / g.config.minSpeed < 1.7f, "speed varies modestly")
    }

    @Test
    fun aCurveNeedsRealSteering() {
        val neutral = TrailWorlds.riding(TrailRideConfig(world = TrailWorlds.curvyEmpty()), seed = 12L)
        TrailPilots.run(neutral, 300f)
        assertTrue(neutral.offTrails >= 1, "holding the head still does not follow the bends")
        assertEquals(TrailCrash.OffTrail, neutral.lastCrash)

        val steered = TrailWorlds.riding(TrailRideConfig(world = TrailWorlds.curvyEmpty()), seed = 12L)
        TrailPilots.run(steered, 300f, steer = { TrailPilots.follow(it) })
        assertEquals(0, steered.offTrails, "steering with the trail keeps the rider on it")
        assertEquals(steered.config.lives, steered.lives)
        assertTrue(steered.distance > 1500f, "and the ride keeps going (${steered.distance} m)")
    }

    @Test
    fun steeringSpeedIsBounded() {
        val g = straightGame(firstDitch = TrailWorlds.NEVER)
        var maxMove = 0f
        var x = g.riderX
        TrailPilots.run(g, 2f, steer = { 1f }) {
            maxMove = maxOf(maxMove, abs(it.riderX - x))
            x = it.riderX
        }
        assertTrue(maxMove <= g.config.steerSpeed * step + 1e-4f, "lateral speed capped ($maxMove per step)")
        assertTrue(g.riderX <= g.config.steerRange + 1e-3f)
    }

    @Test
    fun leavingTheTrailNeedsASustainedExcursion() {
        val g = straightGame(firstDitch = TrailWorlds.NEVER)
        val limit = g.config.world.halfWidth + g.config.edgeTolerance
        var beyondAt = Float.NaN
        var edgeWarned = false
        TrailPilots.run(g, 3f, steer = { 1f }) {
            if (it.nearEdge) edgeWarned = true
            if (beyondAt.isNaN() && abs(it.lateralError) > limit) beyondAt = it.elapsed
        }
        assertTrue(edgeWarned, "edge warning before leaving the trail")
        assertEquals(1, g.offTrails)
        assertEquals(TrailCrash.OffTrail, g.lastCrash)
        val delay = g.lastCrashAt - beyondAt
        assertTrue(delay >= g.config.offTrailSeconds - step * 1.5f && delay <= g.config.offTrailSeconds + step * 2.5f, "tolerance before failing ($delay s)")
    }

    @Test
    fun obstaclesHitOrMissDependOnPosition() {
        val aimed = straightGame(firstDitch = TrailWorlds.NEVER, obstacles = true)
        var firstCrash = TrailCrash.None
        TrailPilots.run(aimed, 30f, steer = { TrailPilots.aim(it) }) {
            if (firstCrash == TrailCrash.None && it.lastCrash != TrailCrash.None) firstCrash = it.lastCrash
        }
        assertTrue(aimed.obstacleHits >= 1)
        assertEquals(TrailCrash.Obstacle, firstCrash, "riding into a trunk is an obstacle crash, not off-trail")

        val dodging = straightGame(firstDitch = TrailWorlds.NEVER, obstacles = true)
        TrailPilots.run(dodging, 240f, steer = { TrailPilots.avoid(it) })
        assertEquals(0, dodging.obstacleHits, "steering into the gap always passes")
        assertEquals(0, dodging.offTrails)
        assertTrue(dodging.dodged > 40, "dodged ${dodging.dodged}")
    }

    @Test
    fun windingTrailWithObstaclesIsPassable() {
        for (seed in listOf(1L, 2L, 3L)) {
            val g = TrailWorlds.riding(TrailRideConfig(world = TrailWorldConfig(firstDitchAt = TrailWorlds.NEVER)), seed)
            TrailPilots.run(g, 400f, steer = { TrailPilots.avoid(it) })
            assertEquals(0, g.obstacleHits, "seed $seed hits")
            assertEquals(0, g.offTrails, "seed $seed off-trail")
            assertTrue(g.level >= 3, "seed $seed reached level ${g.level}")
        }
    }

    @Test
    fun invulnerabilityStopsRepeatedDamage() {
        val dense = TrailWorlds.straight(firstDitch = TrailWorlds.NEVER, obstacles = true)
            .copy(obstacleSpacing = 4f, minObstacleSpacing = 4f, obstacleSpacingJitter = 0f, obstacleSpacingPerLevel = 0f)
        val g = TrailWorlds.riding(TrailRideConfig(world = dense, lives = 50))
        val crashes = ArrayList<Float>()
        var lives = g.lives
        TrailPilots.run(g, 60f, steer = { TrailPilots.aim(it) }) {
            if (it.lives != lives) {
                assertEquals(lives - 1, it.lives, "one life per crash")
                lives = it.lives
                crashes += it.lastCrashAt
            }
        }
        assertTrue(crashes.size >= 3, "crashes ${crashes.size}")
        for (i in 1 until crashes.size) {
            val gap = crashes[i] - crashes[i - 1]
            assertTrue(gap >= g.config.crashSeconds + g.config.invulnerableSeconds - step, "crash gap $gap s")
        }
        assertTrue(g.world.obstacles.none { it.hit && !it.resolved })
    }

    @Test
    fun aDitchCannotBeSteeredAround() {
        for (steer in listOf(-0.3f, 0f, 0.3f)) {
            val g = straightGame()
            val ditch = g.world.ditches.first()
            TrailPilots.run(g, 25f, steer = { steer })
            assertEquals(1, g.ditchesMissed, "steer $steer")
            assertEquals(TrailCrash.Ditch, g.lastCrash)
            assertEquals(g.config.lives - 1, g.lives)
            assertTrue(g.distance > ditch.end, "recovery continues past the ditch")
            TrailPilots.run(g, 5f, steer = { steer })
            assertEquals(1, g.ditchesMissed, "the same ditch is never replayed")
        }
    }

    @Test
    fun aJumpInsideTheTakeoffWindowClearsTheDitch() {
        for (lead in listOf(0.2f, 0.6f, 0.9f, 1.2f)) {
            val g = jumpAt(lead)
            assertEquals(1, g.jumpsCleared, "lead $lead s")
            assertEquals(0, g.ditchesMissed)
            assertEquals(g.config.lives, g.lives)
            assertEquals(JumpResult.Clean, g.lastJump)
            assertTrue(g.score >= TrailRideGame.JUMP_POINTS)
        }
    }

    @Test
    fun tooEarlyOrTooLateFails() {
        for (lead in listOf(1.5f, 2.5f)) {
            val g = jumpAt(lead)
            assertEquals(JumpResult.Early, g.lastJump, "lead $lead")
            assertEquals(1, g.ditchesMissed)
            assertEquals(TrailCrash.Ditch, g.lastCrash)
        }
        for (lead in listOf(0.08f, 0.02f)) {
            val g = jumpAt(lead)
            assertEquals(JumpResult.Late, g.lastJump, "lead $lead")
            assertEquals(1, g.ditchesMissed, "a late hop that would physically span the ditch still fails")
        }
    }

    @Test
    fun theRiderStaysAirborneAcrossTheWholeDitch() {
        val g = straightGame()
        val ditch = g.world.ditches.first()
        var requested = false
        var groundedOverDitch = false
        while (!ditch.resolved) {
            if (!requested && g.timeTo(ditch) <= 1.1f) {
                g.requestJump()
                requested = true
            }
            g.step(step, 0f, 70f)
            if (g.distance > ditch.start && g.distance < ditch.end && !g.airborne) groundedOverDitch = true
            if (g.jumpQualified) assertTrue(g.airHeight > 0f)
        }
        assertFalse(groundedOverDitch)
        assertTrue(ditch.cleared)
    }

    @Test
    fun eachDitchNeedsItsOwnSurge() {
        val g = straightGame(ditchSpacing = 160f)
        val first = g.world.ditches.first()
        var requested = false
        TrailPilots.run(g, 40f) {
            if (!requested && !first.resolved && it.timeTo(first) <= 0.8f) {
                it.requestJump()
                requested = true
            }
        }
        assertTrue(first.cleared)
        assertEquals(1, g.ditchesMissed, "the second ditch was not jumped")
        val g2 = straightGame(ditchSpacing = 160f)
        TrailPilots.run(g2, 40f) {
            val next = it.nextDitch()
            if (next != null && !it.airborne && abs(it.timeTo(next) - 0.8f) < step) it.requestJump()
        }
        assertTrue(g2.distance > 250f && g2.distance < 410f, "two ditches reached (${g2.distance} m)")
        assertEquals(2, g2.jumpsCleared)
        assertEquals(0, g2.ditchesMissed)
    }

    @Test
    fun largeStepsCannotSkipHazards() {
        val g = straightGame()
        TrailPilots.run(g, 30f, dt = 0.5f)
        assertEquals(1, g.ditchesMissed, "a 3+ m step still crosses a 1.6 m ditch")
        val o = straightGame(firstDitch = TrailWorlds.NEVER, obstacles = true)
        TrailPilots.run(o, 20f, dt = 0.4f, steer = { TrailPilots.aim(it) })
        assertTrue(o.obstacleHits >= 1, "obstacles are swept, not sampled")
    }

    @Test
    fun jumpRequestsOutsideRidingAreDiscarded() {
        val g = TrailRideGame(TrailRideConfig(world = TrailWorlds.straight()))
        g.requestJump()
        while (g.phase == TrailPhase.Ready) g.step(step, 0f, 70f)
        g.step(step, 0f, 70f)
        assertFalse(g.airborne, "a surge during the countdown does nothing")
        g.requestJump()
        g.resetClock()
        g.step(step, 0f, 70f)
        assertFalse(g.airborne, "a hold drops a pending jump")
        g.requestJump()
        g.step(step, 0f, 70f)
        assertTrue(g.airborne)
        assertEquals(JumpResult.Hop, g.lastJump, "far from any ditch it is only a hop")
    }

    @Test
    fun frameGapsAreBounded() {
        val g = straightGame(firstDitch = TrailWorlds.NEVER)
        assertEquals(0, g.advance(1_000_000_000L, 0f, 70f))
        val steps = g.advance(6_000_000_000L, 0f, 70f)
        assertEquals((g.config.maxFrame / g.config.step).toInt(), steps, "a 5 s stall advances at most maxFrame")
    }

    private class Outcome(val distance: Float, val lives: Int, val cleared: Int, val missed: Int, val hits: Int, val offTrail: Int, val dodged: Int, val score: Int)

    private fun rideAtFrameRate(frames: (Random) -> Long): Outcome {
        val g = TrailWorlds.riding(TrailRideConfig(), seed = 31L)
        val rng = Random(5)
        var now = 1_000_000_000L
        g.advance(now, 0f, 72f)
        while (g.elapsed < 150f) {
            now += frames(rng)
            val next = g.nextDitch()
            if (next != null && !g.airborne && g.phase == TrailPhase.Riding) {
                val t = g.timeTo(next)
                if (t in 0.6f..0.9f) g.requestJump()
            }
            g.advance(now, TrailPilots.avoid(g), 72f)
        }
        return Outcome(g.distance, g.lives, g.jumpsCleared, g.ditchesMissed, g.obstacleHits, g.offTrails, g.dodged, g.score)
    }

    @Test
    fun outcomesDoNotDependOnTheRenderingFrameRate() {
        val fast = rideAtFrameRate { 16_666_667L }
        val normal = rideAtFrameRate { 33_333_333L }
        val jittery = rideAtFrameRate { r -> (20 + r.nextInt(60)) * 1_000_000L }
        for (o in listOf(normal, jittery)) {
            assertEquals(fast.lives, o.lives)
            assertEquals(fast.cleared, o.cleared)
            assertEquals(fast.missed, o.missed)
            assertEquals(fast.hits, o.hits)
            assertEquals(fast.offTrail, o.offTrail)
            assertEquals(fast.dodged, o.dodged)
            assertEquals(fast.distance, o.distance, 2f)
        }
        assertTrue(fast.cleared >= 4, "the pilot jumped ${fast.cleared} ditches")
        assertEquals(0, fast.missed)
    }

    @Test
    fun scoringRewardsDistanceDodgesJumpsAndLevels() {
        val g = TrailWorlds.riding(TrailRideConfig(), seed = 31L)
        TrailPilots.run(g, 140f, steer = { TrailPilots.avoid(it) }) {
            val next = it.nextDitch()
            if (next != null && !it.airborne && abs(it.timeTo(next) - 0.8f) < step) it.requestJump()
        }
        val levels = (1..g.levelReached).sumOf { TrailRideGame.LEVEL_POINTS * it }
        val expected = g.distance * TrailRideGame.DISTANCE_POINTS + g.dodged * TrailRideGame.DODGE_POINTS + g.jumpsCleared * TrailRideGame.JUMP_POINTS + levels
        assertEquals(expected, g.score.toFloat(), 3f)
        assertTrue(g.levelReached >= 1)
    }

    @Test
    fun threeLivesThenGameOverAndRestartClearsEverything() {
        val g = straightGame(firstDitch = TrailWorlds.NEVER)
        TrailPilots.run(g, 30f, steer = { 1f })
        assertEquals(TrailPhase.GameOver, g.phase)
        assertEquals(0, g.lives)
        assertEquals(3, g.offTrails)
        val before = g.distance
        TrailPilots.run(g, 2f)
        assertEquals(before, g.distance, "nothing moves after game over")
        g.requestJump()
        g.restart(7L)
        assertEquals(TrailPhase.Ready, g.phase)
        assertEquals(g.config.lives, g.lives)
        assertEquals(0, g.score)
        assertEquals(0f, g.distance)
        assertEquals(0f, g.riderX)
        assertFalse(g.airborne)
        assertEquals(TrailCrash.None, g.lastCrash)
        assertEquals(JumpResult.None, g.lastJump)
        assertEquals(0, g.offTrails)
        val fresh = TrailRideGame(g.config, 7L)
        assertEquals(fresh.world.ditches.map { it.start }, g.world.ditches.map { it.start })
        assertEquals(fresh.world.obstacles.map { it.x }, g.world.obstacles.map { it.x })
        while (g.phase == TrailPhase.Ready) g.step(step, 0f, 70f)
        g.step(step, 0f, 70f)
        assertFalse(g.airborne, "no stale jump after restart")
    }

    @Test
    fun restartAfterAJumpDropsTheAirborneState() {
        val g = straightGame()
        val ditch = g.world.ditches.first()
        while (g.timeTo(ditch) > 0.8f) g.step(step, 0f, 70f)
        g.requestJump()
        g.step(step, 0f, 70f)
        assertTrue(g.airborne)
        g.restart(3L)
        assertFalse(g.airborne)
        assertEquals(0f, g.airHeight)
        assertEquals(-1, g.world.ditches.indexOfFirst { it.resolved })
    }

    // ---- end to end through the session with real cadence detection ----------------------

    private fun surgeRide(surgeLead: Float, surgeRpm: Int = 88): SessionDriver {
        val d = SessionDriver(TrailRideSession(TrailRideGame(TrailRideConfig(world = TrailWorlds.straight()), 3L)))
        d.untilRiding()
        val ditch = d.game.world.ditches.first()
        var guard = 0
        while (!ditch.resolved && guard++ < 3000) {
            val t = d.game.timeTo(ditch)
            d.rpm = if (t <= surgeLead) surgeRpm else 70
            d.frame()
        }
        return d
    }

    @Test
    fun aConfirmedSurgeStartedOnTheCueClearsTheDitch() {
        val cue = TrailRideConfig().let { it.jumpEarlySeconds + it.surgeCueLead }
        val d = surgeRide(surgeLead = cue)
        assertEquals(1, d.session.jumpRequests)
        assertEquals(1, d.game.jumpsCleared, "jump ${d.game.lastJump} at ${d.game.jumpTimeToDitch} s")
        assertEquals(d.game.config.lives, d.game.lives)
    }

    @Test
    fun aSurgeStartedFarTooEarlyCannotClearTheDitch() {
        val d = surgeRide(surgeLead = 3.5f)
        assertEquals(1, d.session.jumpRequests, "holding the surge does not retrigger")
        assertEquals(1, d.game.ditchesMissed)
        assertEquals(TrailCrash.Ditch, d.game.lastCrash)
    }

    @Test
    fun theTakeoffWindowCoversRealDetectorLatency() {
        // Telemetry every 250 ms and a 350 ms / 2-sample confirmation: the surge is confirmed
        // 0.5-0.75 s after it starts. Any start from the cue down to ~0.9 s before the ditch must work.
        var cleared = 0
        val leads = listOf(0.95f, 1.1f, 1.25f, 1.4f, 1.55f, 1.7f)
        for (lead in leads) if (surgeRide(lead).game.jumpsCleared == 1) cleared += 1
        assertEquals(leads.size, cleared, "every lead in the fair span clears")
    }

    @Test
    fun gameSourcesStayReadOnly() {
        for (name in listOf("TrailRideGame.kt", "TrailRideWorld.kt", "TrailRideControls.kt", "TrailRideView.kt")) {
            val text = File("src/main/kotlin/com/fitbaus/arcade/$name").readText()
            for (token in listOf("esistance", "UsbManager", "bikebridge", "java.net", "HttpURLConnection")) {
                assertFalse(text.contains(token), "$name mentions $token")
            }
        }
    }
}
