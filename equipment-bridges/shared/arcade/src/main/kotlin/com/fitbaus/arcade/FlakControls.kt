// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs

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

internal enum class CadenceState { NoTelemetry, Stale, Stopped, Establishing, Cruising, Boosting, Recovering }

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
    val pace: Float = Float.NaN,
    val paceSpread: Float = Float.NaN,
    val paceSamples: Int = 0,
    val steadyProgress: Float = 0f,
    val confirming: Int = 0,
    val sinceNearMs: Long = -1L,
) {
    val boosting: Boolean
        get() = state == CadenceState.Boosting

    val pedaling: Boolean
        get() = state == CadenceState.Establishing || state == CadenceState.Cruising || state == CadenceState.Boosting || state == CadenceState.Recovering
}

internal data class CadenceConfig(
    val minPedalRpm: Int = 20,
    val establishNanos: Long = 3_000_000_000L,
    val deltaRpm: Int = 12,
    val minDeltaRpm: Int = 6,
    val maxDeltaRpm: Int = 25,
    val confirmNanos: Long = 350_000_000L,
    val confirmSamples: Int = 2,
    val riseNanos: Long = 2_000_000_000L,
    val minBoostNanos: Long = 1_000_000_000L,
    val staleNanos: Long = 2_000_000_000L,
    val steadySpanNanos: Long = 2_000_000_000L,
    val steadySamples: Int = 4,
    val steadyToleranceRpm: Int = 3,
    val baselineDeadbandRpm: Float = 1f,
    val paceFallbackNanos: Long = 6_000_000_000L,
    val rebaselineAfterNanos: Long = 10_000_000_000L,
) {
    val delta: Int
        get() = deltaRpm.coerceIn(minDeltaRpm, maxDeltaRpm)
}

/**
 * Read-only cadence: turns fresh RPM telemetry into a cruising baseline and a one-second evasive
 * dash relative to it.
 *
 * Learning: the first steady pace (see below) after at least [CadenceConfig.establishNanos] of
 * pedaling becomes the baseline. Armed: while cruising, every steady window moves the baseline to
 * its pace (higher or lower), so the reference is always the recent cruising pace, never the
 * starting one. A dash needs [CadenceConfig.confirmSamples] distinct fresh samples at or above
 * baseline + delta spanning [CadenceConfig.confirmNanos], and the first of them must arrive within
 * [CadenceConfig.riseNanos] of the last sample near the baseline, so a slow drift in cadence is
 * never mistaken for a burst. The baseline is frozen while a surge is being confirmed. Boosting:
 * the dash lasts exactly [CadenceConfig.minBoostNanos]; samples during it are ignored, so they
 * neither extend it nor leak into any reference. Recovering: after the dash, only fresh samples
 * count; the first steady pace (at any level) becomes the new baseline and rearms. Because the
 * rearm reference is the held cadence itself, holding it can never light another dash.
 *
 * The pace of a window is the mean of the middle half of its sorted samples, so a lone spike never
 * moves it. A steady pace is the shortest run of most recent samples spanning
 * [CadenceConfig.steadySpanNanos] with at least [CadenceConfig.steadySamples] samples, at least 80%
 * of them (and the newest) within [CadenceConfig.steadyToleranceRpm] of that pace. If no steady pace
 * appears within [CadenceConfig.paceFallbackNanos] of fresh evidence, the pace is accepted anyway
 * once the newest sample is within half the surge delta of it, so an erratic rider is never locked
 * out and a rider still spinning up is not rearmed below their current cadence.
 *
 * Stopping, stale telemetry or a telemetry gap cancels any dash and returns to recovery with no
 * evidence; a stop of [CadenceConfig.rebaselineAfterNanos] relearns from scratch. Stale, missing or
 * repeated samples are never processed, so they can never light a dash or settle a pace.
 */
internal class CadenceBoost(config: CadenceConfig = CadenceConfig()) {
    private enum class Phase { Learning, Armed, Boosting, Recovering }

    var config: CadenceConfig = config
        private set
    private var lastObservedAt: String? = null
    private var lastSampleNanos = Long.MIN_VALUE
    private var lastRpm: Int? = null
    private var baseline = Float.NaN
    private var phase = Phase.Learning
    private var stoppedSince = Long.MIN_VALUE
    private var aboveSince = Long.MIN_VALUE
    private var aboveCount = 0
    private var nearAt = Long.MIN_VALUE
    private var boostUntil = Long.MIN_VALUE
    private val times = LongArray(WINDOW)
    private val rpms = IntArray(WINDOW)
    private val scratch = IntArray(WINDOW)
    private var head = 0
    private var count = 0
    private var evidenceSince = Long.MIN_VALUE
    private var pace = Float.NaN
    private var paceSpread = Float.NaN
    private var paceSamples = 0
    private var paceCovered = false
    private var paceSteady = false
    private var newestNear = false
    private var newestWithinHalfDelta = false
    private var steadyProgress = 0f
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
        phase = Phase.Learning
        stoppedSince = Long.MIN_VALUE
        nearAt = Long.MIN_VALUE
        boostUntil = Long.MIN_VALUE
        clearPending()
        clearWindow()
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
            interrupt()
            return reading(CadenceState.Stale, nowNanos, simulated)
        }
        endBoostIfDue(nowNanos)
        val state = when {
            (lastRpm ?: 0) < config.minPedalRpm -> CadenceState.Stopped
            phase == Phase.Boosting -> CadenceState.Boosting
            phase == Phase.Learning -> CadenceState.Establishing
            phase == Phase.Recovering -> CadenceState.Recovering
            else -> CadenceState.Cruising
        }
        return reading(state, nowNanos, simulated)
    }

    private fun absorb(rpm: Int, now: Long) {
        if (lastSampleNanos != Long.MIN_VALUE && now - lastSampleNanos > config.staleNanos) interrupt()
        lastSampleNanos = now
        lastRpm = rpm
        endBoostIfDue(now)
        if (rpm < config.minPedalRpm) {
            if (stoppedSince == Long.MIN_VALUE) stoppedSince = now
            interrupt()
            if (now - stoppedSince >= config.rebaselineAfterNanos) {
                baseline = Float.NaN
                phase = Phase.Learning
            }
            return
        }
        stoppedSince = Long.MIN_VALUE
        if (phase == Phase.Boosting) return
        push(now, rpm)
        assess()
        when (phase) {
            Phase.Learning -> if (paceSettled(now, config.establishNanos)) settle(now)
            Phase.Recovering -> if (paceSettled(now, 0L)) settle(now)
            Phase.Armed -> track(rpm, now)
            Phase.Boosting -> Unit
        }
    }

    private fun track(rpm: Int, now: Long) {
        val pending = aboveCount > 0
        if (rpm >= baseline + config.delta && (pending || now - nearAt <= config.riseNanos)) {
            if (!pending) aboveSince = now
            aboveCount += 1
            if (aboveCount >= config.confirmSamples && now - aboveSince >= config.confirmNanos) activate(now)
            return
        }
        clearPending()
        if (paceSteady && abs(pace - baseline) > config.baselineDeadbandRpm) baseline = pace
        if (rpm <= baseline + config.steadyToleranceRpm) nearAt = now
    }

    private fun activate(now: Long) {
        boostUntil = now + config.minBoostNanos
        phase = Phase.Boosting
        activations += 1
        clearPending()
        clearWindow()
    }

    private fun endBoostIfDue(now: Long) {
        if (phase == Phase.Boosting && now >= boostUntil) {
            phase = Phase.Recovering
            clearWindow()
        }
    }

    private fun settle(now: Long) {
        baseline = pace
        phase = Phase.Armed
        nearAt = now
        clearPending()
    }

    private fun interrupt() {
        boostUntil = Long.MIN_VALUE
        clearPending()
        clearWindow()
        phase = if (baseline.isNaN()) Phase.Learning else Phase.Recovering
    }

    private fun paceSettled(now: Long, minEvidenceNanos: Long): Boolean {
        val evidence = now - evidenceSince
        if (evidence < minEvidenceNanos) return false
        return paceSteady || (paceCovered && newestWithinHalfDelta && evidence >= config.paceFallbackNanos)
    }

    private fun clearPending() {
        aboveCount = 0
        aboveSince = Long.MIN_VALUE
    }

    private fun clearWindow() {
        head = 0
        count = 0
        evidenceSince = Long.MIN_VALUE
        pace = Float.NaN
        paceSpread = Float.NaN
        paceSamples = 0
        paceCovered = false
        paceSteady = false
        newestNear = false
        newestWithinHalfDelta = false
        steadyProgress = 0f
    }

    private fun push(now: Long, rpm: Int) {
        if (count == 0) evidenceSince = now
        times[head] = now
        rpms[head] = rpm
        head = (head + 1) % WINDOW
        if (count < WINDOW) count += 1
    }

    private fun assess() {
        val newest = (head - 1 + WINDOW) % WINDOW
        val newestAt = times[newest]
        var n = 0
        var span = 0L
        while (n < count) {
            val i = (newest - n + WINDOW) % WINDOW
            val v = rpms[i]
            var j = n
            while (j > 0 && scratch[j - 1] > v) {
                scratch[j] = scratch[j - 1]
                j -= 1
            }
            scratch[j] = v
            span = newestAt - times[i]
            n += 1
            if (span >= config.steadySpanNanos) break
        }
        val lo = n / 4
        val hi = n - 1 - n / 4
        var sum = 0
        for (k in lo..hi) sum += scratch[k]
        val centre = sum.toFloat() / (hi - lo + 1)
        val tolerance = config.steadyToleranceRpm
        var inside = 0
        var worst = 0f
        for (k in 0 until n) {
            val d = abs(scratch[k] - centre)
            if (d <= tolerance) inside += 1
            if (d > worst) worst = d
        }
        val consistent = inside * 5 >= n * 4
        val newestOffset = abs(rpms[newest] - centre)
        pace = centre
        paceSpread = worst
        paceSamples = n
        newestNear = newestOffset <= tolerance
        newestWithinHalfDelta = newestOffset <= config.delta / 2f
        paceCovered = n >= config.steadySamples && span >= config.steadySpanNanos
        paceSteady = paceCovered && consistent && newestNear
        steadyProgress = if (consistent && newestNear) {
            minOf(span.toFloat() / config.steadySpanNanos, n.toFloat() / config.steadySamples, 1f)
        } else {
            0f
        }
    }

    private fun reading(state: CadenceState, now: Long, simulated: Boolean): CadenceReading = CadenceReading(
        state = state,
        rpm = if (state == CadenceState.NoTelemetry) null else lastRpm,
        sampleAgeMs = if (lastSampleNanos == Long.MIN_VALUE) -1L else (now - lastSampleNanos) / 1_000_000L,
        baseline = baseline,
        threshold = if (baseline.isNaN()) Float.NaN else baseline + config.delta,
        boostRemainingMs = if (phase == Phase.Boosting && now < boostUntil) (boostUntil - now) / 1_000_000L else 0L,
        activations = activations,
        simulated = simulated,
        armed = phase == Phase.Armed,
        pace = pace,
        paceSpread = paceSpread,
        paceSamples = paceSamples,
        steadyProgress = steadyProgress,
        confirming = aboveCount,
        sinceNearMs = if (phase == Phase.Armed && nearAt != Long.MIN_VALUE) (now - nearAt) / 1_000_000L else -1L,
    )

    private companion object {
        const val WINDOW = 48
    }
}
