// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.exp

internal enum class CadenceMode(val label: String, val key: String, val hint: String) {
    PedalToSlow("PEDAL TO SLOW", "slow", "PEDAL FASTER FOR MORE TIME"),
    PedalToSpeedUp("PEDAL TO SPEED UP", "speed", "PEDAL FASTER FOR MORE CHALLENGE"),
    ;

    companion object {
        val DEFAULT: CadenceMode = PedalToSlow

        fun fromKey(key: String?): CadenceMode = values().firstOrNull { it.key == key } ?: DEFAULT
    }
}

internal enum class CadenceStatus { Live, Stale, NoTelemetry }

internal data class CadenceGravityConfig(
    val lowRpm: Float = 40f,
    val highRpm: Float = 100f,
    val shortMultiplier: Float = 0.75f,
    val longMultiplier: Float = 1.25f,
    val rpmTauNanos: Long = 800_000_000L,
    val multiplierTauNanos: Long = 300_000_000L,
    val neutralTauNanos: Long = 1_500_000_000L,
    val staleNanos: Long = 2_000_000_000L,
    val maxStepNanos: Long = 250_000_000L,
    val minIntervalSeconds: Float = 0.1f,
    val maxRpm: Float = 160f,
    val maxSampleJump: Float = 30f,
) {
    init {
        require(highRpm > lowRpm && lowRpm >= 0f) { "invalid cadence range" }
        require(shortMultiplier > 0f && longMultiplier > shortMultiplier) { "invalid multipliers" }
        require(maxRpm >= highRpm && maxSampleJump > 0f) { "invalid rpm limits" }
        require(rpmTauNanos > 0L && multiplierTauNanos > 0L && neutralTauNanos > 0L && staleNanos > 0L && maxStepNanos > 0L) { "invalid timing" }
    }

    val neutralRpm: Float
        get() = (lowRpm + highRpm) / 2f

    fun normalized(rpm: Float): Float = ((rpm - lowRpm) / (highRpm - lowRpm)).coerceIn(0f, 1f)

    fun multiplier(mode: CadenceMode, rpm: Float): Float {
        val t = normalized(rpm)
        val span = longMultiplier - shortMultiplier
        return when (mode) {
            CadenceMode.PedalToSlow -> shortMultiplier + span * t
            CadenceMode.PedalToSpeedUp -> longMultiplier - span * t
        }
    }

    fun interval(levelSeconds: Float, multiplier: Float): Float = maxOf(minIntervalSeconds, levelSeconds * multiplier)
}

/**
 * Turns read-only bike cadence into a gravity interval multiplier for BIKETRIS. Absolute RPM (not
 * a learned pace) is smoothed with a time-based first-order filter, so a repeated telemetry sample
 * only adds time, never weight; the filter input may sit at most [CadenceGravityConfig.maxSampleJump]
 * from the filtered value, so a single spike moves the result a little while a sustained change
 * still converges. The mapping clamps the filtered RPM to the calibrated range. A sample counts as new only when its observation timestamp changes, it is
 * current, and the bike is connected and initialized; zero RPM is a valid sample. Without a new
 * sample for [CadenceGravityConfig.staleNanos], or without telemetry, the filtered cadence drifts
 * back to the neutral RPM, so the multiplier returns to 1.0 and no old sample keeps an advantage.
 * The applied multiplier follows the target with its own short time constant, so mode switches and
 * recoveries change the fall speed smoothly. Elapsed time per update is capped, so pauses and stalls
 * never cause a jump.
 */
internal class CadenceGravity(val config: CadenceGravityConfig = CadenceGravityConfig()) {
    private var lastObservedAt: String? = null
    private var lastSampleNanos = Long.MIN_VALUE
    private var lastUpdateNanos = Long.MIN_VALUE

    var mode: CadenceMode = CadenceMode.DEFAULT
    var status: CadenceStatus = CadenceStatus.NoTelemetry
        private set
    var rawRpm: Int = -1
        private set
    var filteredRpm: Float = config.neutralRpm
        private set
    var targetMultiplier: Float = 1f
        private set
    var appliedMultiplier: Float = 1f
        private set
    var samples: Int = 0
        private set
    var sampleAgeMs: Long = -1L
        private set

    val live: Boolean
        get() = status == CadenceStatus.Live

    fun reset() {
        lastObservedAt = null
        lastSampleNanos = Long.MIN_VALUE
        lastUpdateNanos = Long.MIN_VALUE
        status = CadenceStatus.NoTelemetry
        rawRpm = -1
        filteredRpm = config.neutralRpm
        targetMultiplier = 1f
        appliedMultiplier = 1f
        samples = 0
        sampleAgeMs = -1L
    }

    fun pauseClock() {
        lastUpdateNanos = Long.MIN_VALUE
    }

    fun update(
        connected: Boolean,
        initialized: Boolean,
        rpm: Int?,
        rpmCurrent: Boolean,
        rpmObservedAt: String?,
        nowNanos: Long,
    ): Float {
        val dt = if (lastUpdateNanos == Long.MIN_VALUE) 0L else (nowNanos - lastUpdateNanos).coerceIn(0L, config.maxStepNanos)
        lastUpdateNanos = nowNanos
        val telemetry = connected && initialized
        if (telemetry && rpmCurrent && rpm != null && rpm >= 0 && rpmObservedAt != null && rpmObservedAt != lastObservedAt) {
            lastObservedAt = rpmObservedAt
            lastSampleNanos = nowNanos
            rawRpm = rpm
            samples += 1
        }
        status = when {
            !telemetry || lastSampleNanos == Long.MIN_VALUE -> CadenceStatus.NoTelemetry
            nowNanos - lastSampleNanos > config.staleNanos -> CadenceStatus.Stale
            else -> CadenceStatus.Live
        }
        sampleAgeMs = if (lastSampleNanos == Long.MIN_VALUE) -1L else (nowNanos - lastSampleNanos) / 1_000_000L
        if (status == CadenceStatus.Live) {
            val goal = rawRpm.toFloat().coerceIn(0f, config.maxRpm).coerceIn(filteredRpm - config.maxSampleJump, filteredRpm + config.maxSampleJump)
            filteredRpm += (goal - filteredRpm) * blend(dt, config.rpmTauNanos)
        } else {
            filteredRpm += (config.neutralRpm - filteredRpm) * blend(dt, config.neutralTauNanos)
        }
        targetMultiplier = config.multiplier(mode, filteredRpm)
        appliedMultiplier += (targetMultiplier - appliedMultiplier) * blend(dt, config.multiplierTauNanos)
        return appliedMultiplier
    }

    fun intervalSeconds(levelSeconds: Float): Float = config.interval(levelSeconds, appliedMultiplier)

    private fun blend(dt: Long, tau: Long): Float = if (dt <= 0L) 0f else (1.0 - exp(-dt.toDouble() / tau)).toFloat()
}

/** Two side-by-side (or stacked) touch segments for choosing the cadence mode. Pure geometry. */
internal class CadenceSelectorLayout {
    var left: Float = 0f
        private set
    var top: Float = 0f
        private set
    var width: Float = 0f
        private set
    var height: Float = 0f
        private set
    var stacked: Boolean = false
        private set

    fun set(left: Float, top: Float, width: Float, height: Float, stacked: Boolean) {
        this.left = left
        this.top = top
        this.width = maxOf(0f, width)
        this.height = maxOf(0f, height)
        this.stacked = stacked
    }

    val visible: Boolean
        get() = width > 0f && height > 0f

    fun segmentLeft(mode: CadenceMode): Float = if (stacked || mode == CadenceMode.PedalToSlow) left else left + width / 2f

    fun segmentRight(mode: CadenceMode): Float = if (stacked || mode == CadenceMode.PedalToSpeedUp) left + width else left + width / 2f

    fun segmentTop(mode: CadenceMode): Float = if (!stacked || mode == CadenceMode.PedalToSlow) top else top + height / 2f

    fun segmentBottom(mode: CadenceMode): Float = if (!stacked || mode == CadenceMode.PedalToSpeedUp) top + height else top + height / 2f

    fun hit(x: Float, y: Float): CadenceMode? {
        if (!visible) return null
        for (mode in CadenceMode.values()) {
            if (x >= segmentLeft(mode) && x < segmentRight(mode) && y >= segmentTop(mode) && y < segmentBottom(mode)) return mode
        }
        return null
    }
}
