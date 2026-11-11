// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import java.util.Locale
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

internal data class BreakoutConfig(
    val width: Float = 1f,
    val height: Float = 0.55f,
    val stepSeconds: Float = 1f / 120f,
    val maxFrameSeconds: Float = 0.1f,
    val paddleWidth: Float = 0.16f,
    val paddleHeight: Float = 0.018f,
    val paddleBottomGap: Float = 0.04f,
    val paddleMaxSpeed: Float = 3f,
    val ballRadius: Float = 0.011f,
    val ballSpeed: Float = 0.5f,
    val ballSpeedPerBrick: Float = 0.006f,
    val ballMaxSpeed: Float = 0.85f,
    val maxBounceRadians: Float = 1.05f,
    val rows: Int = 6,
    val columns: Int = 10,
    val brickTop: Float = 0.07f,
    val brickHeight: Float = 0.026f,
    val brickGap: Float = 0.006f,
    val lives: Int = 3,
    val serveDelaySeconds: Float = 1.0f,
    val resumeDelaySeconds: Float = 0.6f,
) {
    init {
        require(width > 0f && height > 0f) { "playfield must have a size" }
        require(stepSeconds > 0f && maxFrameSeconds >= stepSeconds) { "invalid timing" }
        require(rows in 1..12 && columns in 1..20) { "invalid brick grid" }
        require(lives >= 1) { "lives must be >= 1" }
    }

    val paddleTop: Float
        get() = height - paddleBottomGap - paddleHeight

    val brickWidth: Float
        get() = (width - brickGap * (columns + 1)) / columns

    fun rowPoints(row: Int): Int = when (row * 6 / rows) {
        0, 1 -> 7
        2, 3 -> 4
        else -> 1
    }
}

internal object BreakoutSpeed {
    const val MIN: Int = 1
    const val MAX: Int = 3
    const val DEFAULT: Int = 3

    fun clamp(level: Int): Int = level.coerceIn(MIN, MAX)

    fun scale(level: Int): Float = clamp(level).toFloat() / MAX
}

internal enum class InputAvailability { Present, HandLost, TrackerUnavailable }

internal data class GameInput(val x: Float, val availability: InputAvailability, val ageNanos: Long = 0L) {
    companion object {
        fun from(position: HandPosition, status: ArcadeStatus, nowNanos: Long): GameInput {
            val failed = status == ArcadeStatus.Unavailable || status == ArcadeStatus.PermissionDenied
            val availability = when {
                position.source == HandSource.Touch -> InputAvailability.Present
                position.source == HandSource.Camera -> InputAvailability.Present
                failed -> InputAvailability.TrackerUnavailable
                else -> InputAvailability.HandLost
            }
            return GameInput(HandMapping.clamp01(position.x), availability, (nowNanos - position.timestampNanos).coerceAtLeast(0L))
        }
    }
}

internal enum class GamePhase { Serving, Playing, Paused, GameOver, Cleared }

internal data class MissRecord(val availability: InputAvailability, val inputAgeMs: Long, val paddleOffset: Float)

internal class BreakoutGame(val config: BreakoutConfig = BreakoutConfig()) {
    private val alive = BooleanArray(config.rows * config.columns)
    private var accumulator = 0f
    private var lastNanos = Long.MIN_VALUE
    private var presentFor = 0f

    var phase: GamePhase = GamePhase.Serving
        private set
    var pauseReason: InputAvailability = InputAvailability.Present
        private set
    var paddleX: Float = config.width / 2f
        private set
    var targetX: Float = config.width / 2f
        private set
    var ballX: Float = 0f
        private set
    var ballY: Float = 0f
        private set
    var ballVX: Float = 0f
        private set
    var ballVY: Float = 0f
        private set
    var speed: Float = config.ballSpeed
        private set
    var score: Int = 0
        private set
    var lives: Int = config.lives
        private set
    var speedLevel: Int = BreakoutSpeed.DEFAULT
        private set
    private var speedScale = BreakoutSpeed.scale(BreakoutSpeed.DEFAULT)

    val ballSpeed: Float
        get() = speed * speedScale
    var bricksLeft: Int = 0
        private set
    var paddleHits: Int = 0
        private set
    var lastInput: GameInput = GameInput(0.5f, InputAvailability.HandLost)
        private set
    val misses: MutableList<MissRecord> = ArrayList()
    var events: ((String) -> Unit)? = null

    init {
        restart()
    }

    fun isAlive(row: Int, column: Int): Boolean = alive[row * config.columns + column]

    fun brickLeft(column: Int): Float = config.brickGap + column * (config.brickWidth + config.brickGap)

    fun brickTop(row: Int): Float = config.brickTop + row * (config.brickHeight + config.brickGap)

    fun restart() {
        alive.fill(true)
        bricksLeft = alive.size
        score = 0
        lives = config.lives
        paddleHits = 0
        misses.clear()
        speed = config.ballSpeed
        paddleX = config.width / 2f
        targetX = paddleX
        serve()
    }

    internal fun placeBallForTest(x: Float, y: Float, vx: Float, vy: Float, paddle: Float = paddleX) {
        ballX = x
        ballY = y
        ballVX = vx
        ballVY = vy
        paddleX = paddle
        targetX = paddle
        phase = GamePhase.Playing
    }

    fun setSpeedLevel(level: Int) {
        val next = BreakoutSpeed.clamp(level)
        if (next == speedLevel) return
        val nextScale = BreakoutSpeed.scale(next)
        ballVX *= nextScale / speedScale
        ballVY *= nextScale / speedScale
        speedLevel = next
        speedScale = nextScale
        events?.invoke("speed ${next}x")
    }

    fun update(nowNanos: Long, input: GameInput) {
        val dt = if (lastNanos == Long.MIN_VALUE) 0f else ((nowNanos - lastNanos) / 1e9f)
        lastNanos = nowNanos
        advance(dt, input)
    }

    fun resetClock() {
        lastNanos = Long.MIN_VALUE
        accumulator = 0f
    }

    fun advance(frameSeconds: Float, input: GameInput) {
        lastInput = input
        accumulator += frameSeconds.coerceIn(0f, config.maxFrameSeconds)
        val step = config.stepSeconds
        while (accumulator >= step - 1e-6f) {
            accumulator -= step
            step(step, input)
        }
    }

    private fun step(dt: Float, input: GameInput) {
        val present = input.availability == InputAvailability.Present
        presentFor = if (present) presentFor + dt else 0f
        if (present) targetX = input.x * config.width
        when (phase) {
            GamePhase.GameOver, GamePhase.Cleared -> return
            GamePhase.Paused -> {
                pauseReason = input.availability
                if (presentFor >= config.resumeDelaySeconds) {
                    phase = GamePhase.Playing
                    events?.invoke("resumed")
                } else {
                    return
                }
            }
            GamePhase.Playing -> if (!present) {
                phase = GamePhase.Paused
                pauseReason = input.availability
                events?.invoke("paused: ${input.availability}")
                return
            }
            GamePhase.Serving -> Unit
        }
        movePaddle(dt)
        if (phase == GamePhase.Serving) {
            holdBallOnPaddle()
            if (presentFor >= config.serveDelaySeconds) launch()
            return
        }
        moveBall(dt, input)
    }

    private fun movePaddle(dt: Float) {
        val half = config.paddleWidth / 2f
        val goal = targetX.coerceIn(half, config.width - half)
        val maxMove = config.paddleMaxSpeed * dt
        val delta = goal - paddleX
        paddleX += delta.coerceIn(-maxMove, maxMove)
    }

    private fun holdBallOnPaddle() {
        ballX = paddleX
        ballY = config.paddleTop - config.ballRadius - 0.001f
        ballVX = 0f
        ballVY = 0f
    }

    private fun serve() {
        phase = GamePhase.Serving
        presentFor = 0f
        holdBallOnPaddle()
    }

    private fun launch() {
        phase = GamePhase.Playing
        val angle = 0.35f * if (score % 2 == 0) 1f else -1f
        ballVX = ballSpeed * sin(angle)
        ballVY = -ballSpeed * cos(angle)
        events?.invoke("served")
    }

    private fun moveBall(dt: Float, input: GameInput) {
        val r = config.ballRadius
        ballX += ballVX * dt
        ballY += ballVY * dt
        if (ballX - r < 0f) {
            ballX = r
            ballVX = abs(ballVX)
        } else if (ballX + r > config.width) {
            ballX = config.width - r
            ballVX = -abs(ballVX)
        }
        if (ballY - r < 0f) {
            ballY = r
            ballVY = abs(ballVY)
        }
        if (ballVY > 0f) collidePaddle()
        collideBricks()
        if (ballY - r > config.height) loseLife(input)
    }

    private fun collidePaddle() {
        val r = config.ballRadius
        val top = config.paddleTop
        val half = config.paddleWidth / 2f
        if (ballY + r < top || ballY - r > top + config.paddleHeight) return
        if (ballX + r < paddleX - half || ballX - r > paddleX + half) return
        val offset = ((ballX - paddleX) / (half + r)).coerceIn(-1f, 1f)
        val angle = offset * config.maxBounceRadians
        ballVX = ballSpeed * sin(angle)
        ballVY = -ballSpeed * cos(angle)
        ballY = top - r - 0.0005f
        paddleHits += 1
    }

    private fun collideBricks() {
        val r = config.ballRadius
        val bw = config.brickWidth
        val bh = config.brickHeight
        val firstRowTop = config.brickTop
        val gridBottom = brickTop(config.rows - 1) + bh
        if (ballY - r > gridBottom || ballY + r < firstRowTop) return
        for (row in 0 until config.rows) {
            val top = brickTop(row)
            if (ballY + r < top || ballY - r > top + bh) continue
            for (column in 0 until config.columns) {
                val index = row * config.columns + column
                if (!alive[index]) continue
                val left = brickLeft(column)
                val nearestX = ballX.coerceIn(left, left + bw)
                val nearestY = ballY.coerceIn(top, top + bh)
                val dx = ballX - nearestX
                val dy = ballY - nearestY
                if (dx * dx + dy * dy > r * r) continue
                alive[index] = false
                bricksLeft -= 1
                score += config.rowPoints(row)
                if (abs(dx) > abs(dy)) {
                    ballVX = if (dx > 0f) abs(ballVX) else -abs(ballVX)
                } else if (dy != 0f) {
                    ballVY = if (dy > 0f) abs(ballVY) else -abs(ballVY)
                } else {
                    ballVY = -ballVY
                }
                speed = min(config.ballMaxSpeed, speed + config.ballSpeedPerBrick)
                normalizeSpeed()
                if (bricksLeft == 0) {
                    phase = GamePhase.Cleared
                    events?.invoke("cleared with score $score")
                }
                return
            }
        }
    }

    private fun normalizeSpeed() {
        val current = sqrt(ballVX * ballVX + ballVY * ballVY)
        if (current <= 0f) return
        ballVX = ballVX / current * ballSpeed
        ballVY = ballVY / current * ballSpeed
    }

    private fun loseLife(input: GameInput) {
        val record = MissRecord(input.availability, input.ageNanos / 1_000_000L, ballX - paddleX)
        misses += record
        lives -= 1
        events?.invoke(
            "missed ball: input ${input.availability} age ${record.inputAgeMs} ms, paddle ${String.format(Locale.US, "%.3f", record.paddleOffset)} from ball, lives $lives",
        )
        if (lives <= 0) {
            phase = GamePhase.GameOver
            events?.invoke("game over with score $score")
        } else {
            serve()
        }
    }
}

internal class GameplayTrace(private val capacity: Int = 120) {
    val target = FloatArray(capacity)
    val paddle = FloatArray(capacity)
    val present = BooleanArray(capacity)
    var count: Int = 0
        private set
    var head: Int = 0
        private set

    fun record(targetX: Float, paddleX: Float, isPresent: Boolean) {
        target[head] = targetX
        paddle[head] = paddleX
        present[head] = isPresent
        head = (head + 1) % capacity
        if (count < capacity) count += 1
    }

    fun index(age: Int): Int = (head - 1 - age + capacity * 2) % capacity
}
