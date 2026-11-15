// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.roundToInt

internal data class BiketrisControlConfig(
    val freshNanos: Long = 400_000_000L,
    val hysteresis: Float = 0.2f,
    val gain: Float = 1f,
    val lostGraceNanos: Long = 600_000_000L,
    val resumeStableNanos: Long = 600_000_000L,
    val eventMaxAgeNanos: Long = 350_000_000L,
)

internal enum class BiketrisControl { Lost, Face, Touch }

internal class BiketrisReading(
    val control: BiketrisControl,
    val x: Float,
    val ageMs: Long,
    val stableMs: Long,
)

/**
 * Maps a player-space x (0 = the player's left, the same mirrored face x Bricks uses) to the
 * active piece's leftmost occupied column. x first scales around the centre by the gain, then
 * spans 0..[maxLeft], so the piece's occupied width always stays on the board. A column change
 * needs the position to pass the midpoint between columns by [BiketrisControlConfig.hysteresis]
 * columns, so tracker jitter near a boundary cannot make the piece oscillate.
 */
internal class HeadColumnMapper(var gain: Float = 1f, private val hysteresis: Float = 0.2f) {
    var column: Int = -1
        private set
    var position: Float = Float.NaN
        private set
    private var span = -1

    fun reset() {
        column = -1
        span = -1
        position = Float.NaN
    }

    fun map(x: Float, maxLeft: Int, scale: Float = gain): Int {
        val bound = maxOf(0, maxLeft)
        val scaled = (0.5f + (HandMapping.clamp01(x) - 0.5f) * scale).coerceIn(0f, 1f)
        val u = scaled * bound
        position = u
        if (column < 0 || bound != span) {
            span = bound
            column = u.roundToInt().coerceIn(0, bound)
            return column
        }
        val threshold = 0.5f + hysteresis
        while (column < bound && u - column > threshold) column += 1
        while (column > 0 && column - u > threshold) column -= 1
        return column
    }
}

internal enum class BiketrisHold { None, CameraStarting, CameraUnavailable, LookToStart, FaceLost, Resuming, GameOver }

/**
 * Decides whether the BIKETRIS clock may run. A fresh face, a finger on the board, or an active
 * touch-play session keeps it live. A face that drops out keeps the piece falling (without
 * sideways movement) for a short grace period; after that everything holds until the face has
 * been stable again.
 */
internal class BiketrisSupervisor(private val config: BiketrisControlConfig = BiketrisControlConfig()) {
    private var running = false
    private var everRan = false
    private var lostSince = Long.MIN_VALUE

    fun invalidate() {
        running = false
        lostSince = Long.MIN_VALUE
    }

    fun restart() {
        invalidate()
        everRan = false
    }

    fun hold(camera: CameraState, reading: BiketrisReading, touchSession: Boolean, gameOver: Boolean, nowNanos: Long): BiketrisHold {
        val hold = when {
            gameOver -> BiketrisHold.GameOver
            reading.control == BiketrisControl.Touch || touchSession -> BiketrisHold.None
            camera == CameraState.Unavailable || camera == CameraState.PermissionDenied -> BiketrisHold.CameraUnavailable
            camera != CameraState.Ready -> BiketrisHold.CameraStarting
            reading.control == BiketrisControl.Lost -> lostHold(nowNanos)
            !running && reading.stableMs * 1_000_000L < config.resumeStableNanos -> BiketrisHold.Resuming
            else -> BiketrisHold.None
        }
        if (reading.control != BiketrisControl.Lost) lostSince = Long.MIN_VALUE
        running = hold == BiketrisHold.None
        if (running) everRan = true
        return hold
    }

    private fun lostHold(now: Long): BiketrisHold {
        if (!running) return if (everRan) BiketrisHold.FaceLost else BiketrisHold.LookToStart
        if (lostSince == Long.MIN_VALUE) lostSince = now
        return if (now - lostSince <= config.lostGraceNanos) BiketrisHold.None else BiketrisHold.FaceLost
    }

    fun message(hold: BiketrisHold): String? = when (hold) {
        BiketrisHold.None, BiketrisHold.GameOver -> null
        BiketrisHold.CameraStarting -> "STARTING CAMERA..."
        BiketrisHold.CameraUnavailable -> "CAMERA UNAVAILABLE - DRAG TO MOVE, TAP ROTATE"
        BiketrisHold.LookToStart -> "LOOK AT THE SCREEN TO START"
        BiketrisHold.FaceLost -> "FACE LOST - LOOK AT THE SCREEN"
        BiketrisHold.Resuming -> "GET READY..."
    }
}

internal enum class WaveOutcome { None, Accepted, Discarded }

/**
 * Turns [WaveGestureInput]'s monotonic sequence into one rotation per event. The first read after
 * [invalidate] only records the current sequence, so an event published before a restart, a pause
 * or a game switch is never replayed. A new event is discarded when the game is not live, when it
 * is older than the age limit, or when it happened before the current piece spawned.
 */
internal class WaveEventEdge(private val maxAgeNanos: Long) {
    private var last = -1L

    fun invalidate() {
        last = -1L
    }

    fun update(event: WaveEvent?, nowNanos: Long, live: Boolean, notBeforeNanos: Long): WaveOutcome {
        val sequence = event?.sequence ?: 0L
        val previous = last
        if (sequence > last || event == null) last = sequence
        if (event == null || previous < 0L || sequence <= previous) return WaveOutcome.None
        val age = nowNanos - event.atNanos
        if (!live || age < 0L || age > maxAgeNanos || event.atNanos < notBeforeNanos) return WaveOutcome.Discarded
        return WaveOutcome.Accepted
    }
}

/**
 * One BIKETRIS frame without Android: read the head (or touch) position, decide the hold, apply at
 * most one wave rotation and one touch rotation, steer the piece toward the mapped column and
 * advance the fixed-step game only while live. While held the game clock is reset.
 *
 * Touch control has two forms. While the face is fresh, a finger on the board only overrides the
 * head while it is down. When the face is not fresh (camera unavailable or starting, or no face
 * tracked), any intentional touch (a drag, a tap on the board or the ROTATE button) starts a
 * persistent touch-play session: the game keeps running without a finger down until the game
 * ends, the mode exits ([pause]), the game restarts, or the face has been fresh for
 * [BiketrisControlConfig.resumeStableNanos] with no finger down, which hands control back to the
 * head without a pause.
 */
internal class BiketrisSession(
    val game: BiketrisGame,
    val config: BiketrisControlConfig = BiketrisControlConfig(),
    val mapper: HeadColumnMapper = HeadColumnMapper(config.gain, config.hysteresis),
    private val supervisor: BiketrisSupervisor = BiketrisSupervisor(config),
) {
    private val edge = WaveEventEdge(config.eventMaxAgeNanos)
    private var freshSince = Long.MIN_VALUE
    private var faceFresh = false
    private var touchIntent = false
    private var pendingTouchRotation = false
    private var seenPieces = -1
    private var pieceSpawnNanos = Long.MIN_VALUE

    var hold: BiketrisHold = BiketrisHold.CameraStarting
        private set
    var reading: BiketrisReading = BiketrisReading(BiketrisControl.Lost, 0.5f, -1L, 0L)
        private set
    var targetColumn: Int = -1
        private set
    var waveRotations: Int = 0
        private set
    var touchRotations: Int = 0
        private set
    var discardedWaves: Int = 0
        private set
    var consumedWaves: Int = 0
        private set
    var blockedWaveRotations: Int = 0
        private set
    var lastWaveRotationNanos: Long = Long.MIN_VALUE
        private set
    var lastWaveSimulated: Boolean = false
        private set
    var lastSteps: Int = 0
        private set
    var touchSession: Boolean = false
        private set

    val live: Boolean
        get() = hold == BiketrisHold.None

    fun update(
        position: HandPosition,
        camera: CameraState,
        touchX: Float,
        wave: WaveEvent?,
        nowNanos: Long,
    ): BiketrisHold {
        reading = read(position, touchX, nowNanos)
        val fingerDown = reading.control == BiketrisControl.Touch
        val gameOver = game.phase == BiketrisPhase.GameOver
        if ((fingerDown || touchIntent) && !faceFresh && !gameOver) touchSession = true
        touchIntent = false
        if (touchSession && !fingerDown && faceFresh && reading.stableMs * 1_000_000L >= config.resumeStableNanos) touchSession = false
        if (gameOver) touchSession = false
        hold = supervisor.hold(camera, reading, touchSession, gameOver, nowNanos)
        trackSpawn(nowNanos)
        when (edge.update(wave, nowNanos, live, pieceSpawnNanos)) {
            WaveOutcome.Accepted -> {
                consumedWaves += 1
                if (game.rotate()) {
                    waveRotations += 1
                    lastWaveRotationNanos = nowNanos
                    lastWaveSimulated = wave?.simulated == true
                } else {
                    blockedWaveRotations += 1
                }
            }
            WaveOutcome.Discarded -> discardedWaves += 1
            WaveOutcome.None -> Unit
        }
        if (pendingTouchRotation) {
            pendingTouchRotation = false
            if (live && game.rotate()) touchRotations += 1
        }
        if (!live) {
            game.clearTarget()
            game.resetClock()
            targetColumn = -1
            lastSteps = 0
            return hold
        }
        targetColumn = when (reading.control) {
            BiketrisControl.Face -> if (touchSession) -1 else mapper.map(reading.x, game.maxLeft)
            BiketrisControl.Touch -> mapper.map(reading.x, game.maxLeft, 1f)
            BiketrisControl.Lost -> -1
        }
        if (targetColumn >= 0) game.setTarget(targetColumn) else game.clearTarget()
        lastSteps = game.update(nowNanos)
        trackSpawn(nowNanos)
        return hold
    }

    fun message(): String? = supervisor.message(hold)

    fun requestTouchRotation() {
        pendingTouchRotation = true
        touchIntent = true
    }

    fun noteTouchIntent() {
        touchIntent = true
    }

    /**
     * Stop the clock and forget transient input. A host pause or mode exit also ends touch play;
     * a render stall passes [endTouchSession] = false so touch play survives it.
     */
    fun pause(endTouchSession: Boolean = true) {
        game.resetClock()
        game.clearTarget()
        supervisor.invalidate()
        edge.invalidate()
        mapper.reset()
        freshSince = Long.MIN_VALUE
        faceFresh = false
        touchIntent = false
        pendingTouchRotation = false
        if (endTouchSession) touchSession = false
    }

    fun restart(seed: Long) {
        game.restart(seed)
        supervisor.restart()
        edge.invalidate()
        mapper.reset()
        freshSince = Long.MIN_VALUE
        faceFresh = false
        touchIntent = false
        touchSession = false
        pendingTouchRotation = false
        seenPieces = -1
        pieceSpawnNanos = Long.MIN_VALUE
        waveRotations = 0
        touchRotations = 0
        discardedWaves = 0
        consumedWaves = 0
        blockedWaveRotations = 0
        lastWaveRotationNanos = Long.MIN_VALUE
    }

    private fun trackSpawn(now: Long) {
        if (game.piecesSpawned != seenPieces) {
            seenPieces = game.piecesSpawned
            pieceSpawnNanos = now
            mapper.reset()
        }
    }

    private fun read(position: HandPosition, touchX: Float, now: Long): BiketrisReading {
        val age = now - position.timestampNanos
        faceFresh = position.source == HandSource.Camera && age in 0..config.freshNanos
        if (faceFresh) {
            if (freshSince == Long.MIN_VALUE) freshSince = now
        } else {
            freshSince = Long.MIN_VALUE
        }
        val stable = if (faceFresh) (now - freshSince) / 1_000_000L else 0L
        if (!touchX.isNaN()) return BiketrisReading(BiketrisControl.Touch, HandMapping.clamp01(touchX), 0L, stable)
        if (!faceFresh) {
            return BiketrisReading(BiketrisControl.Lost, position.x, if (position.source == HandSource.Camera) age / 1_000_000L else -1L, 0L)
        }
        return BiketrisReading(BiketrisControl.Face, position.x, age / 1_000_000L, stable)
    }
}
