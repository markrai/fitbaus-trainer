// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs
import kotlin.math.exp

internal enum class FaceControlState { Lost, Calibrating, Tracking }

internal class FaceControlReading(
    val state: FaceControlState,
    val noseY: Float,
    val neutralY: Float,
    val target: Float,
    val ageMs: Long,
    val stableMs: Long,
    val targetX: Float = 0.5f,
)

internal data class FaceControlConfig(
    val freshNanos: Long = 400_000_000L,
    val calibrationNanos: Long = 1_000_000_000L,
    val calibrationSamples: Int = 6,
    val deadZone: Float = 0.008f,
    val gain: Float = 6f,
)

/**
 * Vertical steering from the nose position. The first second of fresh tracking after a
 * (re)calibration defines the neutral height; afterwards the jet target is the offset from that
 * neutral, minus a small dead zone, multiplied by [FaceControlConfig.gain]. Moving the head up
 * moves the jet up. Only fresh camera samples are used: a lost or stale face never steers.
 */
internal class VerticalFaceControl(config: FaceControlConfig = FaceControlConfig()) {
    var config: FaceControlConfig = config
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

    fun update(position: HandPosition, nowNanos: Long): FaceControlReading {
        val age = nowNanos - position.timestampNanos
        val fresh = position.source == HandSource.Camera && age in 0..config.freshNanos
        if (!fresh) {
            freshSince = Long.MIN_VALUE
            if (!calibrated) {
                calibrationSum = 0f
                calibrationCount = 0
                calibrationStart = Long.MIN_VALUE
            }
            return FaceControlReading(FaceControlState.Lost, position.y, neutral, 0.5f, if (position.source == HandSource.Camera) age / 1_000_000L else -1L, 0L)
        }
        if (freshSince == Long.MIN_VALUE) freshSince = nowNanos
        val stable = (nowNanos - freshSince) / 1_000_000L
        if (!calibrated) {
            if (position.timestampNanos != lastSampleNanos) {
                lastSampleNanos = position.timestampNanos
                if (calibrationStart == Long.MIN_VALUE) calibrationStart = nowNanos
                calibrationSum += position.y
                calibrationCount += 1
            }
            if (calibrationCount >= config.calibrationSamples && nowNanos - calibrationStart >= config.calibrationNanos) {
                neutral = calibrationSum / calibrationCount
            } else {
                return FaceControlReading(FaceControlState.Calibrating, position.y, neutral, 0.5f, age / 1_000_000L, stable)
            }
        }
        lastSampleNanos = position.timestampNanos
        return FaceControlReading(FaceControlState.Tracking, position.y, neutral, targetFor(position.y), age / 1_000_000L, stable, position.x)
    }

    fun targetFor(noseY: Float): Float {
        val offset = noseY - neutral
        val beyond = if (abs(offset) <= config.deadZone) 0f else offset - config.deadZone * (if (offset > 0f) 1f else -1f)
        return (0.5f + beyond * config.gain).coerceIn(0f, 1f)
    }
}

internal enum class CadenceState { NoTelemetry, Stale, Stopped, Establishing, Cruising, Boosting }

internal class CadenceReading(
    val state: CadenceState,
    val rpm: Int?,
    val sampleAgeMs: Long,
    val baseline: Float,
    val threshold: Float,
    val boostRemainingMs: Long,
    val activations: Int,
    val simulated: Boolean,
    val armed: Boolean = true,
) {
    val boosting: Boolean
        get() = state == CadenceState.Boosting

    val pedaling: Boolean
        get() = state == CadenceState.Establishing || state == CadenceState.Cruising || state == CadenceState.Boosting
}

internal data class CadenceConfig(
    val minPedalRpm: Int = 20,
    val establishNanos: Long = 3_000_000_000L,
    val deltaRpm: Int = 12,
    val minDeltaRpm: Int = 6,
    val maxDeltaRpm: Int = 25,
    val confirmNanos: Long = 350_000_000L,
    val confirmSamples: Int = 2,
    val sustainHysteresisRpm: Int = 3,
    val minBoostNanos: Long = 1_000_000_000L,
    val staleNanos: Long = 2_000_000_000L,
    val baselineTauNanos: Long = 8_000_000_000L,
    val resumeSettleNanos: Long = 2_000_000_000L,
    val rebaselineAfterNanos: Long = 10_000_000_000L,
) {
    val delta: Int
        get() = deltaRpm.coerceIn(minDeltaRpm, maxDeltaRpm)
}

/**
 * Read-only cadence: turns fresh RPM telemetry into a baseline and a one-second evasive dash.
 * A dash lights once [CadenceConfig.confirmSamples] distinct fresh samples at or above
 * baseline + delta span [CadenceConfig.confirmNanos], then ends at [CadenceConfig.minBoostNanos]
 * even if cadence stays high. Held cadence cannot extend or retrigger it. The next dash needs a
 * genuine drop below the threshold minus [CadenceConfig.sustainHysteresisRpm], then another
 * confirmed surge. The baseline adapts slowly, only while cruising below that hysteresis band,
 * never during a dash or while still above the rearm line. Stale, missing or repeated samples
 * are never processed, so they can never light a dash.
 */
internal class CadenceBoost(config: CadenceConfig = CadenceConfig()) {
    var config: CadenceConfig = config
        private set
    private var lastObservedAt: String? = null
    private var lastSampleNanos = Long.MIN_VALUE
    private var lastRpm: Int? = null
    private var baseline = Float.NaN
    private var establishSum = 0f
    private var establishCount = 0
    private var pedalingSince = Long.MIN_VALUE
    private var stoppedSince = Long.MIN_VALUE
    private var settleUntil = Long.MIN_VALUE
    private var aboveSince = Long.MIN_VALUE
    private var aboveCount = 0
    private var boostUntil = Long.MIN_VALUE
    private var armed = true
    var activations: Int = 0
        private set

    fun setDelta(delta: Int) {
        config = config.copy(deltaRpm = delta)
    }

    fun reset() {
        lastObservedAt = null
        lastSampleNanos = Long.MIN_VALUE
        lastRpm = null
        baseline = Float.NaN
        establishSum = 0f
        establishCount = 0
        pedalingSince = Long.MIN_VALUE
        stoppedSince = Long.MIN_VALUE
        settleUntil = Long.MIN_VALUE
        aboveSince = Long.MIN_VALUE
        aboveCount = 0
        boostUntil = Long.MIN_VALUE
        armed = true
    }

    fun update(
        connected: Boolean,
        initialized: Boolean,
        rpm: Int?,
        rpmCurrent: Boolean,
        rpmObservedAt: String?,
        nowNanos: Long,
        simulated: Boolean = false,
    ): CadenceReading {
        if (!connected || !initialized) return reading(CadenceState.NoTelemetry, nowNanos, simulated)
        val isNew = rpmObservedAt != null && rpmObservedAt != lastObservedAt
        if (isNew && rpmCurrent && rpm != null && rpm >= 0) {
            lastObservedAt = rpmObservedAt
            absorb(rpm, nowNanos)
        }
        if (lastSampleNanos == Long.MIN_VALUE) return reading(CadenceState.NoTelemetry, nowNanos, simulated)
        if (nowNanos - lastSampleNanos > config.staleNanos) {
            aboveCount = 0
            aboveSince = Long.MIN_VALUE
            boostUntil = Long.MIN_VALUE
            return reading(CadenceState.Stale, nowNanos, simulated)
        }
        val state = when {
            (lastRpm ?: 0) < config.minPedalRpm -> CadenceState.Stopped
            nowNanos < boostUntil -> CadenceState.Boosting
            baseline.isNaN() -> CadenceState.Establishing
            else -> CadenceState.Cruising
        }
        return reading(state, nowNanos, simulated)
    }

    private fun absorb(rpm: Int, now: Long) {
        val previousSample = lastSampleNanos
        lastSampleNanos = now
        lastRpm = rpm
        if (rpm < config.minPedalRpm) {
            if (stoppedSince == Long.MIN_VALUE) stoppedSince = now
            pedalingSince = Long.MIN_VALUE
            aboveCount = 0
            aboveSince = Long.MIN_VALUE
            boostUntil = Long.MIN_VALUE
            armed = true
            if (now - stoppedSince >= config.rebaselineAfterNanos) {
                baseline = Float.NaN
                establishSum = 0f
                establishCount = 0
            }
            return
        }
        if (pedalingSince == Long.MIN_VALUE) {
            pedalingSince = now
            settleUntil = now + config.resumeSettleNanos
            stoppedSince = Long.MIN_VALUE
            establishSum = 0f
            establishCount = 0
        }
        if (baseline.isNaN()) {
            establishSum += rpm
            establishCount += 1
            if (now - pedalingSince >= config.establishNanos) baseline = establishSum / establishCount
            return
        }
        val delta = config.delta
        val threshold = baseline + delta
        val rearmBelow = threshold - config.sustainHysteresisRpm
        if (rpm < rearmBelow) armed = true
        if (now < boostUntil) return
        if (rpm >= threshold && now >= settleUntil) {
            if (!armed) {
                aboveCount = 0
                aboveSince = Long.MIN_VALUE
                return
            }
            if (aboveCount == 0) aboveSince = now
            aboveCount += 1
            if (aboveCount >= config.confirmSamples && now - aboveSince >= config.confirmNanos) {
                boostUntil = now + config.minBoostNanos
                armed = false
                aboveCount = 0
                aboveSince = Long.MIN_VALUE
                activations += 1
            }
            return
        }
        aboveCount = 0
        aboveSince = Long.MIN_VALUE
        if (previousSample != Long.MIN_VALUE && rpm < rearmBelow) {
            val dt = (now - previousSample).coerceIn(0L, 1_000_000_000L)
            val alpha = 1f - exp(-dt.toDouble() / config.baselineTauNanos).toFloat()
            val clamped = rpm.toFloat().coerceIn(baseline - delta, baseline + delta / 2f)
            baseline += alpha * (clamped - baseline)
        }
    }

    private fun reading(state: CadenceState, now: Long, simulated: Boolean): CadenceReading = CadenceReading(
        state = state,
        rpm = if (state == CadenceState.NoTelemetry) null else lastRpm,
        sampleAgeMs = if (lastSampleNanos == Long.MIN_VALUE) -1L else (now - lastSampleNanos) / 1_000_000L,
        baseline = baseline,
        threshold = if (baseline.isNaN()) Float.NaN else baseline + config.delta,
        boostRemainingMs = if (now < boostUntil) (boostUntil - now) / 1_000_000L else 0L,
        activations = activations,
        simulated = simulated,
        armed = armed,
    )
}
