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

internal enum class TrailHold { None, NoTelemetry, NotPedaling }

internal class TrailRideSupervisor {
    fun hold(cadence: CadenceReading): TrailHold = when (cadence.state) {
        CadenceState.NoTelemetry, CadenceState.Stale -> TrailHold.NoTelemetry
        CadenceState.Stopped -> TrailHold.NotPedaling
        else -> TrailHold.None
    }

    fun message(hold: TrailHold, cadence: CadenceReading): String? = when (hold) {
        TrailHold.None -> null
        TrailHold.NoTelemetry -> if (cadence.state == CadenceState.Stale) "BIKE DATA STALE - WAITING FOR RPM" else "NO BIKE DATA - WAITING FOR RPM"
        TrailHold.NotPedaling -> "PEDAL TO RIDE"
    }
}

internal data class StandJumpConfig(
    val freshNanos: Long = 400_000_000L,
    val riseWindowNanos: Long = 650_000_000L,
    val lossWindowNanos: Long = 950_000_000L,
    val maximumSampleGapNanos: Long = 250_000_000L,
    val rearmNanos: Long = 300_000_000L,
    val rearmSamples: Int = 4,
    val minimumRise: Float = 0.075f,
    val minimumFinalStep: Float = 0.008f,
)

internal class StandJumpDetector(val config: StandJumpConfig = StandJumpConfig()) {
    private data class Sample(val at: Long, val y: Float)

    private val samples = ArrayDeque<Sample>()
    private var lastProcessedAt = Long.MIN_VALUE
    private var lastFreshAt = Long.MIN_VALUE
    private var trackingSince = Long.MIN_VALUE
    private var ascentAt = Long.MIN_VALUE
    private var freshCount = 0
    private var tracking = false

    var armed: Boolean = false
        private set
    var lastRise: Float = 0f
        private set
    var lastEvent: String = "waiting for face"
        private set
    var jumps: Int = 0
        private set

    fun update(position: HandPosition, camera: CameraState, nowNanos: Long, canJump: Boolean): Boolean {
        val age = nowNanos - position.timestampNanos
        val fresh = camera == CameraState.Ready && position.source == HandSource.Camera &&
            age in 0..config.freshNanos && position.y.isFinite() && position.y in 0f..1f
        if (fresh) {
            if (position.timestampNanos == lastProcessedAt) return false
            if (!tracking || lastProcessedAt != Long.MIN_VALUE &&
                position.timestampNanos - lastProcessedAt > config.maximumSampleGapNanos
            ) {
                samples.clear()
                trackingSince = nowNanos
                freshCount = 0
                ascentAt = Long.MIN_VALUE
                armed = false
            }
            tracking = true
            freshCount += 1
            while (samples.isNotEmpty() &&
                position.timestampNanos - samples.first().at > config.riseWindowNanos
            ) samples.removeFirst()
            val peak = samples.maxOfOrNull { it.y } ?: position.y
            val previous = samples.lastOrNull()
            val rise = (peak - position.y).coerceAtLeast(0f)
            lastRise = rise
            if (armed && rise >= config.minimumRise &&
                previous != null && previous.y - position.y >= config.minimumFinalStep &&
                position.timestampNanos - previous.at <= config.maximumSampleGapNanos
            ) {
                ascentAt = nowNanos
                lastEvent = "upward movement"
            }
            samples.addLast(Sample(position.timestampNanos, position.y))
            lastProcessedAt = position.timestampNanos
            lastFreshAt = nowNanos
            if (!armed && nowNanos - trackingSince >= config.rearmNanos &&
                freshCount >= config.rearmSamples
            ) {
                armed = true
                lastEvent = "ready"
            }
            return false
        }
        if (position.source != HandSource.Lost || !tracking) return false
        val rising = ascentAt != Long.MIN_VALUE && lastFreshAt != Long.MIN_VALUE &&
            nowNanos >= ascentAt && nowNanos - ascentAt <= config.lossWindowNanos &&
            nowNanos - lastFreshAt <= config.lossWindowNanos
        val triggered = armed && rising && canJump && camera == CameraState.Ready
        lastEvent = when {
            triggered -> "stand jump"
            !armed -> "unarmed loss"
            !rising -> "no upward exit"
            !canJump -> "jump unavailable"
            else -> "camera unavailable"
        }
        if (triggered) jumps += 1
        tracking = false
        armed = false
        samples.clear()
        trackingSince = Long.MIN_VALUE
        ascentAt = Long.MIN_VALUE
        freshCount = 0
        return triggered
    }

    fun reset() {
        samples.clear()
        lastProcessedAt = Long.MIN_VALUE
        lastFreshAt = Long.MIN_VALUE
        trackingSince = Long.MIN_VALUE
        ascentAt = Long.MIN_VALUE
        freshCount = 0
        tracking = false
        armed = false
        lastRise = 0f
        lastEvent = "waiting for face"
    }
}

internal class TrailRideSession(
    val game: TrailRideGame,
    val steering: HorizontalFaceSteering = HorizontalFaceSteering(),
    val cadence: CadenceBoost = CadenceBoost(),
    val standing: StandJumpDetector = StandJumpDetector(),
    private val supervisor: TrailRideSupervisor = TrailRideSupervisor(),
) {
    var hold: TrailHold = TrailHold.NoTelemetry
        private set
    var steer: SteerReading = SteerReading(FaceControlState.Lost, 0.5f, Float.NaN, 0f, -1L, 0L)
        private set
    var cadenceReading: CadenceReading = CadenceReading(CadenceState.NoTelemetry, null, -1L, Float.NaN, Float.NaN, 0L, 0, false)
        private set
    var lastSteps: Int = 0
        private set
    var jumpRequests: Int = 0
        private set
    private var lastSteer = 0f

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
        if (steer.state == FaceControlState.Tracking) lastSteer = steer.steer
        cadenceReading = cadence.update(connected, initialized, rpm, rpmCurrent, rpmObservedAt, nowNanos, simulated)
        hold = supervisor.hold(cadenceReading)
        if (standing.update(
                position, camera, nowNanos,
                canJump = live && game.phase == TrailPhase.Riding && !game.airborne,
            )
        ) {
            jumpRequests += 1
            game.requestJump()
        }
        if (live) {
            lastSteps = game.advance(nowNanos, lastSteer, (cadenceReading.rpm ?: 0).toFloat())
        } else {
            game.resetClock()
            lastSteps = 0
        }
        return hold
    }

    fun message(): String? = supervisor.message(hold, cadenceReading)

    fun pause() {
        game.resetClock()
        steering.invalidate()
        standing.reset()
        lastSteer = 0f
    }

    fun restart(seed: Long) {
        game.restart(seed)
        steering.recalibrate()
        standing.reset()
        lastSteer = 0f
    }

    fun recenter() {
        steering.recalibrate()
        standing.reset()
        lastSteer = 0f
    }

    fun resetCadence() {
        cadence.reset()
        standing.reset()
    }
}
