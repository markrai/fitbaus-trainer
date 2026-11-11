// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.abs
import kotlin.math.sqrt

class BreakoutGameTest {
    private val present = GameInput(0.5f, InputAvailability.Present)
    private val lost = GameInput(0.5f, InputAvailability.HandLost)

    private fun BreakoutGame.run(seconds: Float, input: GameInput, frame: Float = 1f / 30f) {
        val frames = kotlin.math.round(seconds / frame).toInt()
        repeat(frames) { advance(frame, input) }
    }

    private fun speedOf(g: BreakoutGame) = sqrt(g.ballVX * g.ballVX + g.ballVY * g.ballVY)

    @Test
    fun servingWaitsForAHandThenLaunches() {
        val g = BreakoutGame()
        g.run(5f, lost)
        assertEquals(GamePhase.Serving, g.phase, "no hand, no serve")
        g.run(0.9f, present)
        assertEquals(GamePhase.Serving, g.phase)
        g.run(0.2f, present)
        assertEquals(GamePhase.Playing, g.phase)
        assertTrue(g.ballVY < 0f, "ball launched upward")
        assertEquals(g.config.ballSpeed, speedOf(g), 1e-4f)
    }

    @Test
    fun simulationIsFrameRateIndependent() {
        val inputs = listOf(0.5f, 0.3f, 0.7f, 0.2f, 0.9f, 0.5f)
        fun play(frame: Float): BreakoutGame {
            val g = BreakoutGame()
            for (x in inputs) g.run(1.5f, GameInput(x, InputAvailability.Present), frame)
            return g
        }
        val a = play(1f / 30f)
        val b = play(1f / 60f)
        val c = play(1f / 120f)
        for (g in listOf(b, c)) {
            assertEquals(a.ballX, g.ballX, 1e-3f)
            assertEquals(a.ballY, g.ballY, 1e-3f)
            assertEquals(a.paddleX, g.paddleX, 1e-3f)
            assertEquals(a.score, g.score)
            assertEquals(a.lives, g.lives)
        }
    }

    @Test
    fun longFrameGapsAreClamped() {
        val g = BreakoutGame(BreakoutConfig(rows = 1))
        g.placeBallForTest(0.5f, 0.3f, 0f, -0.5f)
        g.advance(5f, present)
        assertEquals(0.3f - 0.5f * g.config.maxFrameSeconds, g.ballY, 2e-3f, "at most one clamped frame of motion")
    }

    @Test
    fun ballBouncesOffWallsAndCeilingAtConstantSpeed() {
        val g = BreakoutGame(BreakoutConfig(rows = 1, brickTop = 0.01f))
        g.placeBallForTest(0.95f, 0.4f, 0.4f, -0.3f)
        g.run(0.3f, present)
        assertTrue(g.ballVX < 0f, "reflected off the right wall")
        assertEquals(0.5f, speedOf(g), 1e-4f)
        g.placeBallForTest(0.05f, 0.4f, -0.4f, 0f)
        g.run(0.3f, present)
        assertTrue(g.ballVX > 0f, "reflected off the left wall")
    }

    @Test
    fun paddleCentreSendsTheBallStraightUpAndEdgesAngleIt() {
        val g = BreakoutGame()
        val top = g.config.paddleTop
        g.placeBallForTest(0.5f, top - 0.03f, 0f, 0.5f, paddle = 0.5f)
        g.run(0.2f, present)
        assertTrue(g.ballVY < 0f)
        assertEquals(0f, g.ballVX, 1e-3f, "centre hit goes straight up")
        assertEquals(1, g.paddleHits)
        g.placeBallForTest(0.5f + g.config.paddleWidth * 0.45f, top - 0.03f, 0f, 0.5f, paddle = 0.5f)
        g.run(0.2f, present)
        assertTrue(g.ballVX > 0.25f, "right-edge hit angles right: ${g.ballVX}")
        assertEquals(2, g.paddleHits)
    }

    @Test
    fun aRisingBallPassesThroughThePaddleLineWithoutBouncing() {
        val g = BreakoutGame()
        g.placeBallForTest(0.5f, g.config.paddleTop + 0.005f, 0f, -0.5f, paddle = 0.5f)
        g.advance(1f / 120f, present)
        assertEquals(0, g.paddleHits)
        assertTrue(g.ballVY < 0f)
    }

    @Test
    fun brickHitScoresRemovesBrickAndReflects() {
        val g = BreakoutGame()
        val row = g.config.rows - 1
        val column = 4
        val x = g.brickLeft(column) + g.config.brickWidth / 2f
        val below = g.brickTop(row) + g.config.brickHeight + 0.03f
        g.placeBallForTest(x, below, 0f, -0.5f)
        g.run(0.2f, present)
        assertFalse(g.isAlive(row, column))
        assertEquals(g.config.rows * g.config.columns - 1, g.bricksLeft)
        assertEquals(g.config.rowPoints(row), g.score)
        assertTrue(g.ballVY > 0f, "bounced back down")
        assertEquals(g.config.ballSpeed + g.config.ballSpeedPerBrick, speedOf(g), 1e-4f, "speeds up per brick")
    }

    @Test
    fun sideHitReflectsHorizontally() {
        val g = BreakoutGame(BreakoutConfig(rows = 1, brickGap = 0.05f))
        val left = g.brickLeft(5)
        val y = g.brickTop(0) + g.config.brickHeight / 2f
        g.placeBallForTest(left - 0.025f, y, 0.5f, 0f)
        g.run(0.05f, present, frame = 1f / 120f)
        assertFalse(g.isAlive(0, 5))
        assertTrue(g.isAlive(0, 4))
        assertTrue(g.ballVX < 0f)
    }

    @Test
    fun oneBrickPerStepAndTopRowsScoreMore() {
        val cfg = BreakoutConfig()
        assertEquals(7, cfg.rowPoints(0))
        assertEquals(4, cfg.rowPoints(2))
        assertEquals(1, cfg.rowPoints(cfg.rows - 1))
        val g = BreakoutGame()
        val between = g.brickLeft(5) - g.config.brickGap / 2f
        g.placeBallForTest(between, g.brickTop(5) + g.config.brickHeight + 0.02f, 0f, -0.5f)
        g.run(0.15f, present)
        assertEquals(1, g.config.rows * g.config.columns - g.bricksLeft, "straddling two bricks still breaks only one per contact")
    }

    @Test
    fun clearingTheLastBrickWins() {
        val g = BreakoutGame(BreakoutConfig(rows = 1, columns = 1))
        val x = g.brickLeft(0) + g.config.brickWidth / 2f
        g.placeBallForTest(x, g.brickTop(0) + g.config.brickHeight + 0.03f, 0f, -0.5f)
        g.run(0.3f, present)
        assertEquals(GamePhase.Cleared, g.phase)
        val frozen = g.ballY
        g.run(1f, present)
        assertEquals(frozen, g.ballY, "a finished game is frozen")
    }

    @Test
    fun missingTheBallCostsALifeAndRecordsTheInputState() {
        val g = BreakoutGame()
        val events = ArrayList<String>()
        g.events = events::add
        g.placeBallForTest(0.1f, g.config.height - 0.01f, 0f, 0.5f, paddle = 0.8f)
        g.run(0.2f, GameInput(0.8f, InputAvailability.Present, ageNanos = 180_000_000L))
        assertEquals(g.config.lives - 1, g.lives)
        assertEquals(GamePhase.Serving, g.phase)
        val miss = g.misses.single()
        assertEquals(InputAvailability.Present, miss.availability)
        assertEquals(180L, miss.inputAgeMs)
        assertTrue(miss.paddleOffset < -0.6f, "ball was far left of the paddle")
        assertTrue(events.any { it.startsWith("missed ball: input Present age 180 ms") }, "$events")
    }

    @Test
    fun lastLifeEndsTheGameAndRestartResetsEverything() {
        val g = BreakoutGame(BreakoutConfig(lives = 2))
        repeat(2) {
            g.placeBallForTest(0.05f, g.config.height - 0.01f, 0f, 0.5f, paddle = 0.9f)
            g.run(0.2f, present)
        }
        assertEquals(GamePhase.GameOver, g.phase)
        assertEquals(0, g.lives)
        g.restart()
        assertEquals(GamePhase.Serving, g.phase)
        assertEquals(2, g.lives)
        assertEquals(0, g.score)
        assertEquals(g.config.rows * g.config.columns, g.bricksLeft)
        assertTrue(g.misses.isEmpty())
    }

    @Test
    fun losingTheHandPausesAndResumesAfterADelay() {
        val g = BreakoutGame()
        g.placeBallForTest(0.5f, 0.3f, 0.2f, -0.3f)
        g.run(0.1f, present)
        g.run(0.1f, lost)
        assertEquals(GamePhase.Paused, g.phase)
        assertEquals(InputAvailability.HandLost, g.pauseReason)
        val x = g.ballX
        val y = g.ballY
        g.run(3f, lost)
        assertEquals(x, g.ballX, "ball frozen while paused")
        assertEquals(y, g.ballY)
        g.run(0.5f, present)
        assertEquals(GamePhase.Paused, g.phase, "short re-appearance does not resume yet")
        g.run(0.2f, present)
        assertEquals(GamePhase.Playing, g.phase)
        assertTrue(abs(g.ballX - x) > 0f || abs(g.ballY - y) > 0f)
    }

    @Test
    fun trackerFailureIsADistinctPauseButTouchStillPlays() {
        val failedNoTouch = GameInput.from(HandPosition(0.4f, 0.5f, 0f, 0L, HandSource.Lost), ArcadeStatus.Unavailable, 0L)
        assertEquals(InputAvailability.TrackerUnavailable, failedNoTouch.availability)
        val touch = GameInput.from(HandPosition(0.4f, 0.5f, 1f, 0L, HandSource.Touch), ArcadeStatus.Unavailable, 0L)
        assertEquals(InputAvailability.Present, touch.availability)
        val lostHand = GameInput.from(HandPosition(0.4f, 0.5f, 0f, 0L, HandSource.Lost), ArcadeStatus.TrackingLost, 0L)
        assertEquals(InputAvailability.HandLost, lostHand.availability)
        val g = BreakoutGame()
        g.placeBallForTest(0.5f, 0.3f, 0.2f, -0.3f)
        g.run(0.1f, failedNoTouch)
        assertEquals(GamePhase.Paused, g.phase)
        assertEquals(InputAvailability.TrackerUnavailable, g.pauseReason)
        assertEquals("CAMERA UNAVAILABLE - TOUCH THE SCREEN TO PLAY", PlaygroundGeometry.banner(g, failedNoTouch.availability))
        g.run(1f, touch)
        assertEquals(GamePhase.Playing, g.phase)
    }

    @Test
    fun gameplayIsIndependentOfTheTrackerBehindTheInput() {
        fun play(source: HandSource): BreakoutGame {
            val g = BreakoutGame()
            var now = 0L
            for (i in 0 until 300) {
                val x = 0.5f + 0.3f * kotlin.math.sin(i / 20f)
                val position = HandPosition(x, 0.5f, 0.9f, now, source)
                g.advance(1f / 30f, GameInput.from(position, ArcadeStatus.Tracking, now))
                now += 33_333_333L
            }
            return g
        }
        val camera = play(HandSource.Camera)
        val touch = play(HandSource.Touch)
        assertEquals(camera.paddleX, touch.paddleX)
        assertEquals(camera.ballX, touch.ballX)
        assertEquals(camera.score, touch.score)
        assertEquals(camera.lives, touch.lives)
    }

    @Test
    fun paddleSpeedIsLimitedAndStaysOnScreen() {
        val g = BreakoutGame()
        g.advance(1f / 30f, GameInput(1f, InputAvailability.Present))
        assertEquals(0.5f + g.config.paddleMaxSpeed / 30f, g.paddleX, 1e-3f, "a 5 Hz jump is spread over frames")
        g.run(2f, GameInput(1f, InputAvailability.Present))
        assertEquals(g.config.width - g.config.paddleWidth / 2f, g.paddleX, 1e-4f)
        g.run(2f, GameInput(0f, InputAvailability.Present))
        assertEquals(g.config.paddleWidth / 2f, g.paddleX, 1e-4f)
        val held = g.paddleX
        g.run(1f, GameInput(0.9f, InputAvailability.HandLost))
        assertEquals(held, g.paddleX, "a lost hand does not move the paddle")
    }

    @Test
    fun updateUsesElapsedTimeAndClockResets() {
        val g = BreakoutGame(BreakoutConfig(rows = 1))
        g.placeBallForTest(0.5f, 0.3f, 0f, -0.5f)
        g.update(1_000_000_000L, present)
        g.update(1_100_000_000L, present)
        assertEquals(0.3f - 0.05f, g.ballY, 2e-3f)
        g.resetClock()
        g.update(9_000_000_000L, present)
        assertEquals(0.25f, g.ballY, 2e-3f, "first update after a reset does not jump")
    }

    @Test
    fun traceKeepsABoundedOrderedHistory() {
        val trace = GameplayTrace(capacity = 4)
        for (i in 0 until 6) trace.record(i / 10f, i / 20f, i % 2 == 0)
        assertEquals(4, trace.count)
        assertEquals(0.5f, trace.target[trace.index(0)], 1e-6f)
        assertEquals(0.2f, trace.target[trace.index(3)], 1e-6f)
        assertFalse(trace.present[trace.index(0)])
    }

    @Test
    fun bannersAndWrapping() {
        val g = BreakoutGame()
        assertEquals("RAISE YOUR HAND TO START", PlaygroundGeometry.banner(g, InputAvailability.HandLost))
        assertEquals("GET READY", PlaygroundGeometry.banner(g, InputAvailability.Present))
        g.placeBallForTest(0.5f, 0.3f, 0f, -0.3f)
        assertEquals(null, PlaygroundGeometry.banner(g, InputAvailability.Present))
        g.run(0.1f, lost)
        assertEquals("HAND LOST - RAISE YOUR HAND TO RESUME", PlaygroundGeometry.banner(g, InputAvailability.HandLost))
        val lines = PlaygroundGeometry.wrap("alpha beta  gamma delta  epsilon zeta", 14)
        assertEquals(listOf("alpha beta", "gamma delta", "epsilon zeta"), lines)
    }

    @Test
    fun speedLevelsScaleTheBallButNotThePaddle() {
        assertEquals(3, BreakoutSpeed.DEFAULT, "the original speed is 3x")
        for (level in 1..3) {
            val g = BreakoutGame()
            g.setSpeedLevel(level)
            g.run(1.1f, present)
            assertEquals(GamePhase.Playing, g.phase)
            assertEquals(g.config.ballSpeed * level / 3f, speedOf(g), 1e-4f, "${level}x launch speed")
        }
        val slow = BreakoutGame()
        slow.setSpeedLevel(1)
        slow.advance(1f / 30f, GameInput(1f, InputAvailability.Present))
        assertEquals(0.5f + slow.config.paddleMaxSpeed / 30f, slow.paddleX, 1e-3f, "paddle response is unchanged at 1x")
        assertEquals(1, BreakoutSpeed.clamp(0))
        assertEquals(3, BreakoutSpeed.clamp(9))
    }

    @Test
    fun changingSpeedMidRallyRescalesTheBallImmediately() {
        val g = BreakoutGame()
        g.placeBallForTest(0.5f, 0.35f, 0.3f, -0.4f)
        g.setSpeedLevel(1)
        assertEquals(0.1f, g.ballVX, 1e-5f)
        assertEquals(-0.4f / 3f, g.ballVY, 1e-5f)
        g.setSpeedLevel(2)
        assertEquals(0.2f, g.ballVX, 1e-5f)
        val events = ArrayList<String>()
        g.events = events::add
        g.setSpeedLevel(2)
        assertTrue(events.isEmpty(), "re-selecting the same speed is a no-op")
        g.setSpeedLevel(3)
        assertEquals(listOf("speed 3x"), events)
    }

    @Test
    fun brickSpeedUpsRespectTheSelectedLevel() {
        val g = BreakoutGame()
        g.setSpeedLevel(1)
        val row = g.config.rows - 1
        val x = g.brickLeft(4) + g.config.brickWidth / 2f
        g.placeBallForTest(x, g.brickTop(row) + g.config.brickHeight + 0.03f, 0f, -g.config.ballSpeed / 3f)
        g.run(0.6f, present)
        assertFalse(g.isAlive(row, 4))
        assertEquals((g.config.ballSpeed + g.config.ballSpeedPerBrick) / 3f, speedOf(g), 1e-4f)
    }

    @Test
    fun speedButtonsHitTestAtTheTopRight() {
        val right = 1000f
        val top = 10f
        val bw = 44f
        val bh = 26f
        val gap = 6f
        assertEquals(1000f - 44f, PlaygroundGeometry.speedButtonLeft(3, right, bw, gap))
        assertEquals(1000f - 88f - 6f, PlaygroundGeometry.speedButtonLeft(2, right, bw, gap))
        assertEquals(1000f - 132f - 12f, PlaygroundGeometry.speedButtonLeft(1, right, bw, gap))
        assertEquals(3, PlaygroundGeometry.speedButtonAt(990f, 20f, right, top, bw, bh, gap))
        assertEquals(2, PlaygroundGeometry.speedButtonAt(930f, 20f, right, top, bw, bh, gap))
        assertEquals(1, PlaygroundGeometry.speedButtonAt(870f, 20f, right, top, bw, bh, gap))
        assertEquals(0, PlaygroundGeometry.speedButtonAt(953f, 20f, right, top, bw, bh, gap), "gap between buttons")
        assertEquals(0, PlaygroundGeometry.speedButtonAt(990f, 60f, right, top, bw, bh, gap), "below the buttons is play area")
        assertEquals(0, PlaygroundGeometry.speedButtonAt(500f, 20f, right, top, bw, bh, gap))
    }
}
