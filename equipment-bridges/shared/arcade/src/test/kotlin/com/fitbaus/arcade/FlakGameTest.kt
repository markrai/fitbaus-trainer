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

    @Test
    fun aShellHitsInNormalFlightButATimedDashEscapesIt() {
        val plain = manual()
        plain.spawnTurret(fireIn = 0.1f)
        run(plain, 2.5f)
        assertEquals(2, plain.lives, "the shell is on course for the jet")
        assertEquals(0, plain.shellsDodged)

        val dashed = manual()
        dashed.spawnTurret(fireIn = 0.1f)
        run(dashed, 2.5f, boost = { t -> t in 0.4f..1.4f })
        assertEquals(3, dashed.lives, "a one-second dash during the flight leaves the shell behind")
        assertEquals(1, dashed.shellsDodged)
    }

    @Test
    fun steeringCannotShakeATrackingShell() {
        val g = manual()
        g.spawnTurret(fireIn = 0.1f)
        run(g, 2.5f, targetY = { t -> if (t < 1f) 0.1f else 0.9f }, targetX = { t -> if (t < 1f) 0.9f else 0.0f })
        assertEquals(2, g.lives, "up/down and left/right are tracked; only extra speed escapes")
    }

    @Test
    fun aOneSecondDashMustBeTimedAgainstTheShellFlight() {
        val flight = FlakConfig().shellFlightSeconds
        fun dodges(fireIn: Float, dashStart: Float): Boolean {
            val g = manual()
            g.spawnTurret(fireIn = fireIn)
            run(g, fireIn + flight + 1.2f, boost = { t -> t >= dashStart && t < dashStart + 1f })
            return g.lives == 3
        }
        assertTrue(dodges(0.1f, 0.1f), "dash at launch")
        assertTrue(dodges(0.1f, 0.6f), "dash mid-flight")
        assertFalse(dodges(1.2f, 0f), "a dash that ends before launch does not count")
        assertFalse(dodges(0.1f, 0.1f + flight + 0.1f), "after the burst is too late")
    }

    @Test
    fun aDashOnOneShellDoesNotSaveTheNextWithoutAnotherDash() {
        val g = manual()
        g.spawnTurret(fireIn = 0.1f)
        run(g, 2.5f, boost = { t -> t in 0.4f..1.4f })
        assertEquals(3, g.lives)
        assertEquals(1, g.shellsDodged)
        g.spawnTurret(fireIn = 0.1f)
        run(g, 2.5f)
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
        val g = FlakGame(random = Random(21))
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
                val burst = s.flight - s.age
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
