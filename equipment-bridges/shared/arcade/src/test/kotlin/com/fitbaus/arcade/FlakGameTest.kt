// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.math.abs
import kotlin.random.Random

class FlakGameTest {
    private fun manual() = FlakGame(autoSpawn = false)

    private fun run(
        game: FlakGame,
        seconds: Float,
        targetY: (Float) -> Float = { 0.5f },
        targetX: (Float) -> Float = { 0.3f },
        boost: (Float) -> Boolean = { false },
    ) {
        val steps = (seconds / game.config.step).toInt()
        var t = 0f
        repeat(steps) {
            game.step(game.config.step, targetY(t), boost(t), targetX(t))
            t += game.config.step
        }
    }

    private val bandXs = floatArrayOf(0f, 0.3f, 0.6f, 1f)
    private val bandYs = floatArrayOf(0f, 0.5f, 1f)

    private fun settled(x0: Float, y0: Float, config: FlakConfig = FlakConfig()): FlakGame {
        val g = FlakGame(config, autoSpawn = false)
        repeat((2f / config.step).toInt()) { g.step(config.step, y0, false, x0) }
        return g
    }

    /** One default turret attack on a jet settled at ([x0], [y0]); inputs are given in seconds after launch. */
    private fun encounter(
        x0: Float,
        y0: Float,
        config: FlakConfig = FlakConfig(),
        steer: (Float) -> Pair<Float, Float> = { y0 to x0 },
        dash: (Float) -> Boolean = { false },
        onLaunch: (Shell) -> Unit = {},
    ): FlakGame {
        val g = settled(x0, y0, config)
        g.spawnTurret()
        var t = 0f
        var launched: Shell? = null
        while (t < config.turretFireSeconds + config.shellFlightSeconds + 0.3f) {
            val tl = t - config.turretFireSeconds
            val (ty, tx) = steer(tl)
            g.step(config.step, ty, dash(tl), tx)
            if (launched == null && g.shells.isNotEmpty()) {
                launched = g.shells.first()
                onLaunch(launched)
            }
            t += config.step
        }
        return g
    }

    private fun hit(g: FlakGame) = g.lives < g.config.lives

    private fun dashFrom(start: Float): (Float) -> Boolean = { tl -> tl >= start && tl < start + 1f }

    @Test
    fun steadyFlightIsHitFromEveryPartOfTheBand() {
        for (x0 in bandXs) for (y0 in bandYs) {
            assertTrue(hit(encounter(x0, y0)), "steady flight at x $x0 y $y0")
            val wiggle = encounter(x0, y0, steer = { tl -> (y0 + 0.05f * kotlin.math.sin(tl * 9.4f)).coerceIn(0f, 1f) to x0 })
            assertTrue(hit(wiggle), "small head movements at x $x0 y $y0 are followed")
        }
    }

    @Test
    fun aShellHitsInNormalFlightButATimedDashEscapesIt() {
        val plain = encounter(0.3f, 0.5f)
        assertEquals(2, plain.lives, "the shell pursues the jet and bursts on it")
        assertEquals(0, plain.shellsDodged)
        val dashed = encounter(0.3f, 0.5f, dash = dashFrom(0.5f))
        assertEquals(3, dashed.lives, "a dash shortly after launch carries the jet past the shell before its fuze arms")
        assertEquals(1, dashed.shellsDodged)
        assertEquals(FlakGame.SHELL_POINTS, dashed.score - plain.score, "a dodged shell scores, a hit does not")
    }

    @Test
    fun aOneSecondDashMustBeTimedAgainstTheShellFlight() {
        fun dodges(start: Float) = !hit(encounter(0.3f, 0.5f, dash = dashFrom(start)))
        for (start in floatArrayOf(0f, 0.2f, 0.4f, 0.6f, 0.8f)) assertTrue(dodges(start), "dash starting $start s after launch")
        assertFalse(dodges(-1.1f), "a dash that ends before launch gives no immunity")
        assertFalse(dodges(1.2f), "a dash after the fuze has armed is too late")
        assertFalse(dodges(FlakConfig().shellFlightSeconds + 0.1f), "a dash after the burst cannot save the jet")
    }

    @Test
    fun aWellTimedDashIsTheMostReliableEscapeAcrossTheBand() {
        var reactive = 0
        var reactiveTries = 0
        var preLaunch = 0
        var preLaunchTries = 0
        var steering = 0
        var steeringTries = 0
        for (x0 in bandXs) for (y0 in bandYs) {
            val modY = if (y0 >= 0.5f) y0 - 0.35f else y0 + 0.35f
            val modX = if (x0 >= 0.5f) x0 - 0.35f else x0 + 0.35f
            var window = false
            for (k in 0..9) {
                val start = k / 10f
                val dodged = !hit(encounter(x0, y0, dash = dashFrom(start)))
                window = window || dodged
                if (start in 0.39f..0.81f) {
                    reactiveTries += 1
                    if (dodged) reactive += 1
                }
            }
            if (!(x0 == 1f && y0 == 1f)) assertTrue(window, "x $x0 y $y0 has a dash window")
            for (start in floatArrayOf(-1.0f, -0.9f, -0.8f, -0.7f, -0.6f)) {
                preLaunchTries += 1
                if (!hit(encounter(x0, y0, dash = dashFrom(start)))) preLaunch += 1
            }
            for (k in 5..10) {
                val tau = k / 10f
                steeringTries += 2
                if (!hit(encounter(x0, y0, steer = { tl -> (if (tl >= tau) modY else y0) to x0 }))) steering += 1
                if (!hit(encounter(x0, y0, steer = { tl -> y0 to (if (tl >= tau) modX else x0) }))) steering += 1
            }
        }
        val dashRate = reactive.toFloat() / reactiveTries
        val steerRate = steering.toFloat() / steeringTries
        assertTrue(dashRate >= 0.7f, "a dash triggered 0.4-0.8 s after launch escapes ${(dashRate * 100).toInt()}%")
        assertTrue(preLaunch.toFloat() / preLaunchTries <= 0.25f, "an early dash escapes only $preLaunch/$preLaunchTries")
        assertTrue(steerRate in 0.25f..0.65f, "moderate mid-flight maneuvers escape ${(steerRate * 100).toInt()}%: possible, not guaranteed")
        assertTrue(dashRate > steerRate + 0.15f, "the dash is clearly more reliable than steering")
    }

    @Test
    fun steeringOutTurnsAShellOnlyWithAWellTimedSharpManeuver() {
        var sharpMid = 0
        var sharpMidTries = 0
        var earlyHits = 0
        var earlyTries = 0
        for (x0 in bandXs) for (y0 in bandYs) {
            val oppY = if (y0 >= 0.5f) 0f else 1f
            val modY = if (y0 >= 0.5f) y0 - 0.35f else y0 + 0.35f
            val modX = if (x0 >= 0.5f) x0 - 0.35f else x0 + 0.35f
            var intercept = 0f
            encounter(x0, y0, onLaunch = { intercept = it.intercept })
            if (intercept < 0.3f) {
                assertTrue(x0 == 1f && y0 == 1f, "only the point-blank corner meets the jet right at launch")
            } else {
                val late = intercept - 0.05f
                assertTrue(hit(encounter(x0, y0, steer = { tl -> (if (tl >= late) oppY else y0) to x0 })), "x $x0 y $y0: a reversal at the last moment is too late")
                assertTrue(hit(encounter(x0, y0, steer = { tl -> y0 to (if (tl >= late) 1f - x0 else x0) })), "x $x0 y $y0: a sideways break at the last moment is too late")
            }
            for (k in 5..10) {
                val tau = k / 10f
                sharpMidTries += 1
                if (!hit(encounter(x0, y0, steer = { tl -> (if (tl >= tau) oppY else y0) to x0 }))) sharpMid += 1
            }
            for (k in 0..3) {
                val tau = k / 10f
                earlyTries += 2
                if (hit(encounter(x0, y0, steer = { tl -> (if (tl >= tau) modY else y0) to x0 }))) earlyHits += 1
                if (hit(encounter(x0, y0, steer = { tl -> y0 to (if (tl >= tau) modX else x0) }))) earlyHits += 1
            }
        }
        assertTrue(sharpMid.toFloat() / sharpMidTries >= 0.4f, "a sharp mid-flight altitude reversal escapes $sharpMid/$sharpMidTries")
        assertTrue(earlyHits.toFloat() / earlyTries >= 0.4f, "after an early move the shell often reacquires: $earlyHits/$earlyTries")
        val gradual = bandXs.sumOf { x0 -> bandYs.count { y0 -> hit(encounter(x0, y0, steer = { tl -> (y0 + ((if (y0 >= 0.5f) 0f else 1f) - y0) * (tl / 3f).coerceIn(0f, 1f)) to x0 })) } }
        assertTrue(gradual >= 6, "a slow altitude change is usually tracked ($gradual/12)")
    }

    @Test
    fun theShellKeepsMomentumAndTurnsNoFasterThanItsTurnRate() {
        val g = settled(0.3f, 0.5f)
        val s = g.launchShell(160f, g.config.groundTop - 8f)
        g.shells += s
        val speed = s.speed
        var heading = s.heading
        var x = s.x
        var y = s.y
        var maxTurn = 0f
        var maxStep = 0f
        var t = 0f
        while (g.shells.isNotEmpty()) {
            g.step(g.config.step, if (t < 0.5f) 0.5f else 0f, false, if ((t * 4).toInt() % 2 == 0) 0.9f else 0.1f)
            t += g.config.step
            if (g.shells.isEmpty()) break
            assertEquals(speed, s.speed, "constant speed")
            var turn = s.heading - heading
            while (turn > Math.PI) turn -= (2 * Math.PI).toFloat()
            while (turn < -Math.PI) turn += (2 * Math.PI).toFloat()
            maxTurn = maxOf(maxTurn, abs(turn))
            maxStep = maxOf(maxStep, kotlin.math.hypot(s.x - x, s.y - y))
            heading = s.heading
            x = s.x
            y = s.y
        }
        assertTrue(maxTurn <= g.config.shellTurnRate * g.config.step + 1e-4f, "turned $maxTurn rad in one step")
        assertTrue(maxStep <= (speed + g.config.scrollSpeed) * g.config.step + 1e-3f, "moved $maxStep in one step: no teleporting")
    }

    @Test
    fun aStationaryJetIsMetOnTimeWithoutTheShellWeaving() {
        var shell: Shell? = null
        var startHeading = 0f
        val g = encounter(0.3f, 0.5f, onLaunch = { shell = it; startHeading = it.heading })
        val s = shell!!
        assertTrue(abs(s.heading - startHeading) < 0.2f, "already on a collision course: barely turned (${s.heading - startHeading} rad)")
        assertTrue(hit(g))
        assertEquals(g.config.shellInterceptSeconds, s.intercept, 0.05f, "met at the planned intercept")
        assertTrue(s.age < s.flight, "the proximity fuze burst before the flight ran out (${s.age} s)")
    }

    @Test
    fun aSuddenManeuverIsFollowedOnlyGradually() {
        val g = settled(0.3f, 0.5f)
        g.spawnTurret(fireIn = 0f)
        g.step(g.config.step, 0.5f, false, 0.3f)
        val shell = g.shells.single()
        val before = shell.heading
        repeat(6) { g.step(g.config.step, 0f, false, 1f) }
        val turned = abs(shell.heading - before)
        assertTrue(turned <= g.config.shellTurnRate * 6 * g.config.step + 1e-4f, "0.1 s after a sharp break the shell turned only $turned rad")
        assertTrue(turned > 0f, "but it does start to turn")
    }

    @Test
    fun anOvershotShellLosesLockAndBurstsWhereItIs() {
        var shell: Shell? = null
        val g = encounter(0.3f, 0.5f, dash = dashFrom(0.5f), onLaunch = { shell = it })
        val s = shell!!
        assertFalse(s.locked, "once the jet is behind its nose the seeker gives up")
        assertEquals(s.flight, s.age, 1e-4f, "no proximity burst: it ran out of flight time")
        val blast = g.blasts.last { it.flak }
        assertEquals(s.x, blast.x, 1e-4f, "the burst is at the shell, not snapped to the jet")
        assertEquals(s.y, blast.y, 1e-4f)
        assertTrue(abs(s.x - g.jetX) >= g.config.burstHalfWidth + g.config.jetHalfWidth || abs(s.y - g.jetY) >= g.config.burstHalfHeight + g.config.jetHalfHeight)
        assertEquals(1, g.shellsDodged)
    }

    @Test
    fun theFuzeCannotTunnelThroughTheJetAtLargeSteps() {
        for (step in floatArrayOf(1f / 120f, 1f / 60f, 1f / 30f, 1f / 15f)) {
            val config = FlakConfig(step = step)
            assertTrue(hit(encounter(0.3f, 0.5f, config)), "steady flight is hit at step $step")
            assertFalse(hit(encounter(0.3f, 0.5f, config, dash = dashFrom(0.5f))), "and a timed dash still escapes at step $step")
        }
    }

    @Test
    fun shellOutcomesAreDeterministic() {
        fun play(): List<Float> {
            val g = encounter(0.6f, 0.2f, steer = { tl -> (if (tl > 0.6f) 0.9f else 0.2f) to 0.6f }, dash = dashFrom(0.3f))
            return listOf(g.lives.toFloat(), g.score.toFloat(), g.jetX, g.jetY) + g.blasts.flatMap { listOf(it.x, it.y) }
        }
        assertEquals(play(), play())
    }

    @Test
    fun aShellBurstingDuringProtectionCostsNothingAndScoresNothing() {
        val g = settled(0.3f, 0.5f)
        g.spawnMissile(g.jetY, warn = 0f)
        while (g.lives == 3) g.step(g.config.step, 0.5f, false, 0.3f)
        g.spawnTurret(fireIn = 0f)
        var steps = 0
        while (g.shells.isNotEmpty() || steps == 0) {
            g.step(g.config.step, 0.5f, false, 0.3f)
            steps += 1
        }
        assertEquals(1, g.hits)
        assertEquals(2, g.lives, "the burst met the jet while it was protected")
        assertEquals(0, g.shellsDodged, "a burst on the jet is not a dodge")
    }

    @Test
    fun aDashOnOneShellDoesNotSaveTheNextWithoutAnotherDash() {
        val g = settled(0.3f, 0.5f)
        g.spawnTurret()
        run(g, g.config.turretFireSeconds + 2.5f, boost = { t -> t >= g.config.turretFireSeconds + 0.5f && t < g.config.turretFireSeconds + 1.5f })
        assertEquals(3, g.lives)
        assertEquals(1, g.shellsDodged)
        g.spawnTurret()
        run(g, g.config.turretFireSeconds + 2.5f)
        assertEquals(2, g.lives, "the next shell still requires a timed dash")
        assertEquals(1, g.shellsDodged)
    }

    @Test
    fun missilesAreDodgedByChangingAltitude() {
        val stay = manual()
        stay.spawnMissile(stay.jetY)
        run(stay, 5f)
        assertEquals(2, stay.lives)

        val dodge = manual()
        dodge.spawnMissile(dodge.jetY)
        run(dodge, 5f, targetY = { 0.2f })
        assertEquals(3, dodge.lives)
        assertEquals(1, dodge.missilesDodged)
        assertEquals(50f + FlakGame.MISSILE_POINTS, dodge.score.toFloat(), 1f, "dodge bonus on top of survival points")
    }

    @Test
    fun missilePairsLeaveASafeLaneBetweenThem() {
        val g = manual()
        val mid = g.jetY
        g.spawnMissilePair(mid + 20f, 40f)
        assertEquals(2, g.missiles.size)
        assertEquals(40f, abs(g.missiles[0].y - g.missiles[1].y), 0.01f)
        run(g, 5f)
        assertEquals(3, g.lives, "flying between the pair is safe")
        assertEquals(2, g.missilesDodged)

        val hit = manual()
        hit.spawnMissilePair(hit.jetY, 40f)
        run(hit, 5f)
        assertEquals(2, hit.lives)
    }

    @Test
    fun theBlackBomberCrossesLeftToRightAtTenPercentFasterThanTheJetAndIsGone() {
        val g = manual()
        val cfg = g.config
        assertEquals(cfg.height * 0.1f, cfg.bomberY, 1e-4f)
        assertTrue(cfg.bomberSpeed > cfg.sideSpeed && cfg.bomberSpeed > cfg.boostScrollSpeed, "always faster than our plane")
        g.spawnBomber(dropX = 200f, warn = 0f)
        val b = g.bombers.single()
        assertTrue(b.x < 0f, "enters from the left edge")
        var lastX = b.x
        var lead = Float.NaN
        var everAhead = false
        while (g.bombers.isNotEmpty()) {
            g.step(cfg.step, 0.9f, true, 1f)
            if (g.bombers.isEmpty()) break
            assertEquals(cfg.bomberY, b.y, 0f, "flies straight and level")
            assertTrue(b.x > lastX)
            lastX = b.x
            if (b.x > g.jetX) {
                everAhead = true
                val gap = b.x - g.jetX
                if (!lead.isNaN()) assertTrue(gap > lead, "the jet cannot keep up, even flying right on a dash")
                lead = gap
            }
        }
        assertTrue(everAhead)
        assertTrue(lastX > cfg.width, "leaves past the right edge, then is removed")
        assertEquals(1, g.bombersPassed)
        assertEquals(3, g.lives)
    }

    @Test
    fun theBombFallsDiagonallyAndExplodesOnTheGround() {
        val g = manual()
        g.spawnBomber(dropX = 180f, warn = 0f)
        var first: Bomb? = null
        var startX = 0f
        var startY = 0f
        var lastBlasts = 0
        var groundBlast: Blast? = null
        repeat((4f / g.config.step).toInt()) {
            g.step(g.config.step, 0.95f, false, 0f)
            val bomb = g.bombs.firstOrNull()
            if (first == null && bomb != null) {
                first = bomb
                startX = bomb.x
                startY = bomb.y
                assertEquals(180f, bomb.x, g.config.bomberSpeed * g.config.step + 0.01f, "dropped as the bomber passes its drop point")
            }
            if (bomb != null && bomb.y > startY + 10f) {
                assertEquals(g.config.bombSpeedX / g.config.bombSpeedY, (bomb.x - startX) / (bomb.y - startY), 1e-3f, "a straight diagonal line")
            }
            if (g.blasts.size > lastBlasts) groundBlast = g.blasts.last()
            lastBlasts = g.blasts.size
        }
        assertTrue(first != null)
        assertTrue(g.bombs.isEmpty())
        assertEquals(1, g.bombsDodged)
        assertEquals(g.config.groundTop - 3f, groundBlast!!.y, 0.01f, "it bursts on the ground")
        assertTrue(groundBlast!!.x > startX + 50f, "well to the right of where it was dropped")
        assertEquals(3, g.lives)
    }

    private fun aimedDrop(g: FlakGame): Float =
        g.jetX - g.config.bombSpeedX * (g.jetY - g.config.bomberY - g.config.bomberHalfHeight) / g.config.bombSpeedY

    @Test
    fun aBombAimedAtTheJetExplodesOnItUnlessTheJetMoves() {
        val hit = manual()
        hit.spawnBomber(dropX = aimedDrop(hit), warn = 0f)
        run(hit, 4f)
        assertEquals(2, hit.lives, "the bomb bursts on the jet")
        assertEquals(1, hit.hits)
        assertEquals(0, hit.bombsDodged)
        assertTrue(hit.bombs.isEmpty())
        assertEquals(1, hit.bombersPassed, "the bomber itself flew high above")

        val dodge = manual()
        dodge.spawnBomber(dropX = aimedDrop(dodge), warn = 0f)
        run(dodge, 4f, targetX = { t -> if (t < 0.4f) 0.3f else 1f })
        assertEquals(3, dodge.lives, "sliding away after the drop avoids it")
        assertEquals(1, dodge.bombsDodged)
    }

    @Test
    fun flyingIntoTheBomberCostsALifeAndItKeepsGoing() {
        val g = manual()
        g.spawnBomber(dropX = 999f, warn = 1f)
        run(g, 4f, targetY = { 0f })
        assertEquals(2, g.lives, "the jet at the top of its band meets the bomber")
        assertEquals(1, g.hits)
        assertTrue(g.bombers.isEmpty(), "it still leaves the screen")
        assertEquals(0, g.bombersPassed)
        assertEquals(1, g.bombsDodged, "its bomb, dropped far right, lands harmlessly")
    }

    @Test
    fun aSlowBomberIsRejected() {
        assertThrows(IllegalArgumentException::class.java) { FlakConfig(bomberSpeed = 70f) }
    }

    @Test
    fun bombersArriveAtRandomIntervalsWithVaryingDrops() {
        val g = FlakGame(FlakConfig(lives = 1000), random = Random(3))
        val seen = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Bomber, Boolean>())
        val drops = HashSet<Int>()
        val spawnTimes = ArrayList<Float>()
        repeat((150f / g.config.step).toInt()) {
            g.step(g.config.step, 0.5f, false, 0.3f)
            for (b in g.bombers) {
                assertEquals(g.config.bomberY, b.y, 0f)
                if (seen.add(b)) {
                    drops += b.dropX.toInt()
                    spawnTimes += g.elapsed
                }
            }
            if (g.phase == FlakPhase.GameOver) g.restart()
        }
        assertTrue(spawnTimes.size >= 7, "bombers keep coming: ${spawnTimes.size} in 150 s")
        assertTrue(spawnTimes.first() >= g.config.firstBomberAt - 0.1f)
        val gaps = spawnTimes.zipWithNext { a, b -> b - a }
        assertTrue(gaps.all { it >= 6.9f }, "spaced out: $gaps")
        assertTrue(gaps.toSet().size > 3, "not on a fixed beat: $gaps")
        assertTrue(drops.size > 3, "drop points vary: $drops")
    }

    @Test
    fun boostingDoesNotDodgeMissiles() {
        val g = manual()
        g.spawnMissile(g.jetY)
        run(g, 5f, boost = { true })
        assertEquals(2, g.lives, "the dash is not a missile answer")
    }

    @Test
    fun headLeftRightMovesTheJetAcrossItsLane() {
        val g = manual()
        run(g, 3f, targetX = { 1f })
        assertEquals(g.config.jetMaxX, g.jetX, 0.5f)
        run(g, 3f, targetX = { 0f })
        assertEquals(g.config.jetMinX, g.jetX, 0.5f)
        val before = g.jetX
        g.step(g.config.step, 0.5f, false, 1f)
        assertEquals(g.config.sideSpeed * g.config.step, g.jetX - before, 1e-3f, "horizontal speed is rate limited")
    }

    @Test
    fun missilesGiveAtLeastTwoSecondsToReactFromTheDefaultLane() {
        val g = manual()
        g.spawnMissile(80f, speed = g.config.maxMissileSpeed)
        assertTrue(g.missileArrival(g.missiles.single()) >= 2f)
    }

    @Test
    fun aHitGivesProtectionSoOneAttackCostsOneLife() {
        val g = manual()
        g.spawnMissile(g.jetY)
        g.spawnMissile(g.jetY, warn = g.config.missileWarnSeconds + 0.3f)
        run(g, 6f)
        assertEquals(2, g.lives)
        assertEquals(1, g.hits)
    }

    /** Steps until the third hit, so the game is exactly at the start of its countdown. */
    private fun gameJustOver(): FlakGame {
        val g = manual()
        repeat(2) {
            g.spawnMissile(g.jetY)
            run(g, 6f)
        }
        g.spawnMissile(g.jetY)
        var steps = 0
        while (g.phase == FlakPhase.Playing) {
            g.step(g.config.step, 0.5f, false)
            steps += 1
            assertTrue(steps < 600, "third hit")
        }
        return g
    }

    @Test
    fun threeHitsEndTheGameThenACountdownRestartsItByItself() {
        val g = gameJustOver()
        assertEquals(0, g.lives)
        assertEquals(3f, g.restartIn, 1e-4f, "a 3-2-1 countdown starts")
        val score = g.score
        val elapsed = g.elapsed
        run(g, 2.9f)
        assertEquals(FlakPhase.GameOver, g.phase, "still counting down")
        assertEquals(score, g.score, "nothing else advances during the countdown")
        assertEquals(elapsed, g.elapsed)
        assertTrue(g.restartIn > 0f && g.restartIn < 0.2f)
        run(g, 0.2f)
        assertEquals(FlakPhase.Playing, g.phase, "restarted without a tap")
        assertEquals(3, g.lives)
        assertTrue(g.score <= 2, "fresh score")
        assertTrue(g.missiles.isEmpty())
        assertEquals(0f, g.restartIn)
        g.restart()
        assertEquals(FlakPhase.Playing, g.phase)
        assertEquals(3, g.lives)
        assertEquals(0, g.score)
        assertTrue(g.missiles.isEmpty())
    }

    @Test
    fun survivalScoresTenPointsPerSecond() {
        val g = manual()
        run(g, 10f)
        assertEquals(100f, g.score.toFloat(), 1f)
    }

    @Test
    fun difficultyRaisesMissileSpeedAndPairsNotEffort() {
        val g = manual()
        assertEquals(85f, g.missileSpeed)
        assertEquals(0.3f, g.pairChance, 1e-4f)
        run(g, 205f)
        assertEquals(5, g.level)
        assertEquals(125f, g.missileSpeed)
        assertEquals(0.7f, g.pairChance, 1e-4f)
        assertEquals(FlakConfig().shellFlightSeconds, g.config.shellFlightSeconds, "shell warning and flight never shrink")
    }

    @Test
    fun attacksAreFrequentWithPairsAndManyTurrets() {
        val g = FlakGame(FlakConfig(lives = 1_000), random = Random(21))
        var maxActiveMissiles = 0
        var turretsSeen = 0
        var lastTurrets = 0
        repeat((200f / g.config.step).toInt()) {
            g.step(g.config.step, 0.5f, true, 0.3f)
            maxActiveMissiles = maxOf(maxActiveMissiles, g.missiles.count { !it.resolved })
            if (g.turrets.size > lastTurrets) turretsSeen += g.turrets.size - lastTurrets
            lastTurrets = g.turrets.size
            if (g.phase == FlakPhase.GameOver) g.restart()
        }
        assertTrue(maxActiveMissiles >= 2, "two missiles at a time")
        assertTrue(turretsSeen >= 28, "turret attacks every few seconds: $turretsSeen in 200 s")
    }

    @Test
    fun missilesNeverArriveRightAsAShellBursts() {
        val g = FlakGame(random = Random(11))
        val conflicts = ArrayList<String>()
        repeat((600f / g.config.step).toInt()) {
            g.step(g.config.step, 0.5f, false, 0.3f)
            for (s in g.shells) {
                val burst = s.intercept - s.age
                for (m in g.missiles) {
                    if (!m.resolved && m.warn > 0f && abs(g.missileArrival(m) - burst) < 0.5f) conflicts += "t=${g.elapsed}"
                }
            }
            if (g.phase == FlakPhase.GameOver) g.restart()
        }
        assertTrue(conflicts.isEmpty(), conflicts.take(3).toString())
    }

    @Test
    fun frameRateDoesNotChangeTheOutcome() {
        fun play(frameMs: Long): Pair<Int, Float> {
            val g = FlakGame(random = Random(9))
            var now = 0L
            g.advance(now, 0.5f, false)
            while (g.elapsed < 60f && g.phase == FlakPhase.Playing) {
                now += frameMs * 1_000_000L
                g.advance(now, 0.3f, false, 0.4f)
            }
            return g.lives to g.jetY
        }
        val fast = play(16)
        assertEquals(fast, play(33))
        assertEquals(fast, play(50))
    }

    @Test
    fun theCountdownRunsOnTheGameClockAtAnyFrameRate() {
        fun framesToRestart(frameMs: Long): Float {
            val g = gameJustOver()
            var now = 0L
            g.advance(now, 0.5f, false)
            var waited = 0f
            while (g.phase == FlakPhase.GameOver) {
                now += frameMs * 1_000_000L
                waited += frameMs / 1000f
                g.advance(now, 0.5f, false)
                assertTrue(waited < 10f)
            }
            return waited
        }
        for (ms in listOf(16L, 33L, 50L)) {
            val waited = framesToRestart(ms)
            assertTrue(waited in 0f..3.2f, "restarted after $waited s at $ms ms frames")
        }
    }

    @Test
    fun resumingNeverCatchesUpOnMissedTime() {
        val g = manual()
        g.advance(0L, 0.5f, false)
        g.advance(100_000_000L, 0.5f, false)
        val before = g.elapsed
        g.resetClock()
        g.advance(30_000_000_000L, 0.5f, false)
        assertEquals(before, g.elapsed, 1e-4f, "the first frame after a pause only re-anchors the clock")
        g.advance(30_016_666_667L, 0.5f, false)
        assertTrue(g.elapsed - before < 0.05f)
        g.advance(60_000_000_000L, 0.5f, false)
        assertTrue(g.elapsed - before <= g.config.maxFrame + 0.05f, "a long frame is capped")
    }

    @Test
    fun jetClimbRateLimitsJitter() {
        val g = manual()
        val start = g.jetY
        g.step(g.config.step, 0f, false)
        assertEquals(g.config.climbSpeed * g.config.step, start - g.jetY, 1e-3f)
    }

    @Test
    fun supervisorHoldsForEveryMissingControllerAndResumesOnlyWhenStable() {
        val s = FlakSupervisor()
        val tracking = FaceControlReading(FaceControlState.Tracking, 0.4f, 0.4f, 0.5f, 10L, 2000L)
        val unstable = FaceControlReading(FaceControlState.Tracking, 0.4f, 0.4f, 0.5f, 10L, 200L)
        val lost = FaceControlReading(FaceControlState.Lost, 0.4f, 0.4f, 0.5f, -1L, 0L)
        val calibrating = FaceControlReading(FaceControlState.Calibrating, 0.4f, Float.NaN, 0.5f, 10L, 300L)
        fun cad(state: CadenceState) = CadenceReading(state, 60, 100L, 60f, 72f, 0L, 0, false)
        val cruising = cad(CadenceState.Cruising)
        val neverCalibrated = FaceControlReading(FaceControlState.Lost, 0.4f, Float.NaN, 0.5f, -1L, 0L)
        assertEquals(FlakHold.None, s.hold(CameraState.Ready, tracking, cruising))
        assertEquals(FlakHold.None, s.hold(CameraState.Ready, lost, cruising), "losing the face after calibration does not pause the game")
        assertEquals(FlakHold.None, s.hold(CameraState.Ready, unstable, cruising), "and reacquiring it adds no extra hold")
        assertEquals(FlakHold.Calibrating, s.hold(CameraState.Ready, calibrating, cruising))
        assertEquals(FlakHold.Resuming, s.hold(CameraState.Ready, unstable, cruising), "fresh but not yet stable after a hold")
        assertEquals(FlakHold.None, s.hold(CameraState.Ready, tracking, cruising))
        assertEquals(FlakHold.None, s.hold(CameraState.Ready, unstable, cruising), "already running: no extra hold")
        assertEquals(FlakHold.NotPedaling, s.hold(CameraState.Ready, lost, cad(CadenceState.Stopped)))
        assertEquals(FlakHold.None, s.hold(CameraState.Ready, lost, cruising), "resuming pedaling with no face is not stuck waiting for a stable view")
        assertEquals(FlakHold.Calibrating, s.hold(CameraState.Ready, neverCalibrated, cruising), "with no neutral yet there is nothing to steer with")
        assertEquals(null, s.message(FlakHold.Calibrating, cruising), "calibration shows no banner")
        assertEquals(FlakHold.NoTelemetry, s.hold(CameraState.Ready, tracking, cad(CadenceState.Stale)))
        assertEquals(FlakHold.NoTelemetry, s.hold(CameraState.Ready, tracking, cad(CadenceState.NoTelemetry)))
        assertEquals(FlakHold.NotPedaling, s.hold(CameraState.Ready, tracking, cad(CadenceState.Stopped)))
        assertEquals(FlakHold.CameraUnavailable, s.hold(CameraState.Unavailable, tracking, cruising))
        assertEquals(FlakHold.CameraStarting, s.hold(CameraState.Starting, tracking, cruising))
        assertEquals(FlakHold.None, s.hold(CameraState.Ready, tracking, cruising), "game over is a countdown, not a hold")
        assertEquals("PEDAL TO FLY", s.message(FlakHold.NotPedaling, cruising))
        assertTrue(s.message(FlakHold.NoTelemetry, cad(CadenceState.Stale))!!.contains("STALE"))
        assertEquals(null, s.message(FlakHold.None, cruising))
    }

    @Test
    fun flakCodeNeverTouchesEquipmentControl() {
        val dir = File("src/main/kotlin/com/fitbaus/arcade")
        val flak = dir.listFiles()!!.filter { it.name.startsWith("Flak") }
        assertEquals(setOf("FlakControls.kt", "FlakGame.kt", "FlakView.kt"), flak.map { it.name }.toSet())
        for (file in flak) {
            val text = file.readText()
            for (forbidden in listOf("setResistance", "requestResistance", "UsbManager", "UsbDevice", "HttpURLConnection", "Socket", "COOLING", "Cooldown")) {
                assertFalse(text.contains(forbidden), "${file.name} mentions $forbidden")
            }
        }
    }

    @Test
    fun facePresetsForFlakAreIndependentOfTheOtherGames() {
        assertEquals(ArcadeTrackerSettings.FACE_DEFAULT, ArcadeTrackerSettings.faceFromKey(null))
        assertEquals(ArcadeTrackerSettings.FACE_DEFAULT, ArcadeTrackerSettings.faceFromKey(ArcadeTrackerSettings.FINGERS_DEFAULT.key))
        assertEquals(ArcadeTrackerSettings.FACE_DEFAULT, ArcadeTrackerSettings.faceFromKey(ArcadeTrackerSettings.CLASSICAL.key))
        for (p in ArcadeTrackerSettings.FACE_PRESETS) {
            assertEquals(ArcadeTrackerMode.Face, p.mode)
            assertEquals(p, ArcadeTrackerSettings.faceFromKey(p.key))
        }
    }
}
