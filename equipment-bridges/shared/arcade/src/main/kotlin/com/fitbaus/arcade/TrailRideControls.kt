// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs

internal class SteerReading(
    val state: FaceControlState,
    val faceX: Float,
    val neutralX: Float,
    val steer: Float,
    val ageMs: Long,
    val stableMs: Long,
)

internal data class SteerConfig(
    val freshNanos: Long = 400_000_000L,
    val calibrationNanos: Long = 1_000_000_000L,
    val calibrationSamples: Int = 6,
    val deadZone: Float = 0.012f,
    val gain: Float = 4f,
)

/**
 * Horizontal head steering for TRAIL RIDE. Uses the same mirrored face x as Bricks (0 = the
 * player's left), so moving the head to the player's left steers left. The first second of fresh
 * tracking after a (re)calibration sets the neutral x; afterwards [SteerReading.steer] is the
 * offset from neutral, minus a small dead zone, times [SteerConfig.gain], clamped to -1..1.
 * Only fresh camera samples steer: a lost or stale face reads [FaceControlState.Lost] and the
 * game holds instead of riding on an old value.
 */
internal class HorizontalFaceSteering(config: SteerConfig = SteerConfig()) {
    var config: SteerConfig = config
        private set
    private var neutral = Float.NaN
    private var calibrationSum = 0f
    private var calibrationCount = 0
    private var calibrationStart = Long.MIN_VALUE
    private var lastSampleNanos = Long.MIN_VALUE
    private var freshSince = Long.MIN_VALUE

    val calibrated: Boolean
        get() = !neutral.isNaN()

    fun setGain(gain: Float) {
        config = config.copy(gain = gain)
    }

    fun recalibrate() {
        neutral = Float.NaN
        calibrationSum = 0f
        calibrationCount = 0
        calibrationStart = Long.MIN_VALUE
    }

    /** Forgets the fresh-tracking run so the next samples must be stable again (host pause, game switch). */
    fun invalidate() {
        freshSince = Long.MIN_VALUE
        if (!calibrated) recalibrate()
    }

    fun update(position: HandPosition, nowNanos: Long): SteerReading {
        val age = nowNanos - position.timestampNanos
        val fresh = position.source == HandSource.Camera && age in 0..config.freshNanos
        if (!fresh) {
            freshSince = Long.MIN_VALUE
            if (!calibrated) recalibrate()
            return SteerReading(FaceControlState.Lost, position.x, neutral, 0f, if (position.source == HandSource.Camera) age / 1_000_000L else -1L, 0L)
        }
        if (freshSince == Long.MIN_VALUE) freshSince = nowNanos
        val stable = (nowNanos - freshSince) / 1_000_000L
        if (!calibrated) {
            if (position.timestampNanos != lastSampleNanos) {
                lastSampleNanos = position.timestampNanos
                if (calibrationStart == Long.MIN_VALUE) calibrationStart = nowNanos
                calibrationSum += position.x
                calibrationCount += 1
            }
            if (calibrationCount >= config.calibrationSamples && nowNanos - calibrationStart >= config.calibrationNanos) {
                neutral = calibrationSum / calibrationCount
            } else {
                return SteerReading(FaceControlState.Calibrating, position.x, neutral, 0f, age / 1_000_000L, stable)
            }
        }
        lastSampleNanos = position.timestampNanos
        return SteerReading(FaceControlState.Tracking, position.x, neutral, steerFor(position.x), age / 1_000_000L, stable)
    }

    fun steerFor(faceX: Float): Float {
        val offset = faceX - neutral
        val beyond = if (abs(offset) <= config.deadZone) 0f else offset - config.deadZone * (if (offset > 0f) 1f else -1f)
        return (beyond * config.gain).coerceIn(-1f, 1f)
    }
}

internal enum class TrailHold { None, CameraStarting, CameraUnavailable, FaceLost, Calibrating, NoTelemetry, NotPedaling, LearningPace, Resuming, GameOver }

/**
 * Decides whether the TRAIL RIDE simulation may run. Any missing controller holds the game and
 * nothing advances while held. The cadence detector must have a baseline before riding, so a
 * ditch can never arrive while a jump is impossible.
 */
internal class TrailRideSupervisor(private val resumeStableMs: Long = 600L) {
    private var running = false

    fun invalidate() {
        running = false
    }

    fun hold(gameOver: Boolean, camera: CameraState, steer: SteerReading, cadence: CadenceReading): TrailHold {
        val hold = when {
            gameOver -> TrailHold.GameOver
            camera == CameraState.Unavailable || camera == CameraState.PermissionDenied -> TrailHold.CameraUnavailable
            camera != CameraState.Ready -> TrailHold.CameraStarting
            steer.state == FaceControlState.Lost -> TrailHold.FaceLost
            steer.state == FaceControlState.Calibrating -> TrailHold.Calibrating
            cadence.state == CadenceState.NoTelemetry || cadence.state == CadenceState.Stale -> TrailHold.NoTelemetry
            cadence.state == CadenceState.Stopped -> TrailHold.NotPedaling
            cadence.state == CadenceState.Establishing -> TrailHold.LearningPace
            !running && steer.stableMs < resumeStableMs -> TrailHold.Resuming
            else -> TrailHold.None
        }
        running = hold == TrailHold.None
        return hold
    }

    fun message(hold: TrailHold, cadence: CadenceReading): String? = when (hold) {
        TrailHold.None -> null
        TrailHold.GameOver -> "GAME OVER - TAP TO RIDE AGAIN"
        TrailHold.CameraUnavailable -> "CAMERA UNAVAILABLE - TRAIL RIDE NEEDS HEAD STEERING"
        TrailHold.CameraStarting -> "STARTING CAMERA..."
        TrailHold.FaceLost -> "FACE LOST - LOOK AT THE SCREEN"
        TrailHold.Calibrating -> "LOOK STRAIGHT AHEAD - CENTERING"
        TrailHold.NoTelemetry -> if (cadence.state == CadenceState.Stale) "BIKE DATA STALE - WAITING FOR RPM" else "NO BIKE DATA - WAITING FOR RPM"
        TrailHold.NotPedaling -> "PEDAL TO RIDE"
        TrailHold.LearningPace -> "KEEP PEDALING - LEARNING YOUR PACE"
        TrailHold.Resuming -> "GET READY..."
    }
}

/**
 * One TRAIL RIDE frame without Android: read head steering and cadence, decide the hold, turn a
 * new confirmed surge into a jump request, and advance the fixed-step game only while live.
 * While held the game clock is reset, so nothing (hazards, jump timers, lives) advances.
 */
internal class TrailRideSession(
    val game: TrailRideGame,
    val steering: HorizontalFaceSteering = HorizontalFaceSteering(),
    val cadence: CadenceBoost = CadenceBoost(),
    private val supervisor: TrailRideSupervisor = TrailRideSupervisor(),
) {
    private val edge = BoostActivationEdge()
    var hold: TrailHold = TrailHold.CameraStarting
        private set
    var steer: SteerReading = SteerReading(FaceControlState.Lost, 0.5f, Float.NaN, 0f, -1L, 0L)
        private set
    var cadenceReading: CadenceReading = CadenceReading(CadenceState.NoTelemetry, null, -1L, Float.NaN, Float.NaN, 0L, 0, false)
        private set
    var lastSteps: Int = 0
        private set
    var jumpRequests: Int = 0
        private set

    val live: Boolean
        get() = hold == TrailHold.None

    fun update(
        position: HandPosition,
        camera: CameraState,
        connected: Boolean,
        initialized: Boolean,
        rpm: Int?,
        rpmCurrent: Boolean,
        rpmObservedAt: String?,
        nowNanos: Long,
        simulated: Boolean = false,
    ): TrailHold {
        steer = steering.update(position, nowNanos)
        cadenceReading = cadence.update(connected, initialized, rpm, rpmCurrent, rpmObservedAt, nowNanos, simulated)
        hold = supervisor.hold(game.phase == TrailPhase.GameOver, camera, steer, cadenceReading)
        if (edge.update(cadenceReading, live)) {
            jumpRequests += 1
            game.requestJump()
        }
        if (live) {
            lastSteps = game.advance(nowNanos, steer.steer, (cadenceReading.rpm ?: 0).toFloat())
        } else {
            game.resetClock()
            lastSteps = 0
        }
        return hold
    }

    fun message(): String? = supervisor.message(hold, cadenceReading)

    /** Host pause or game switch: stop the clock and forget transient input. */
    fun pause() {
        game.resetClock()
        steering.invalidate()
        supervisor.invalidate()
        edge.invalidate()
    }

    fun restart(seed: Long) {
        game.restart(seed)
        steering.recalibrate()
        supervisor.invalidate()
        edge.invalidate()
    }

    fun recenter() {
        steering.recalibrate()
        supervisor.invalidate()
    }

    fun resetCadence() {
        cadence.reset()
        edge.invalidate()
    }
}

/**
 * Turns the cadence detector's monotonic activation counter into one-shot jump requests. Only an
 * activation observed while the game is live counts; activations seen while held, or before the
 * first reading after [invalidate], are absorbed so an old surge is never replayed.
 */
internal class BoostActivationEdge {
    private var last = -1

    fun invalidate() {
        last = -1
    }

    fun update(reading: CadenceReading, live: Boolean): Boolean {
        val previous = last
        last = reading.activations
        return live && previous >= 0 && reading.activations > previous
    }
}
