// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import com.fitbaus.bikebridge.protocol.PairingToken

internal interface IntPersistence {
    fun load(): Int?
    fun save(value: Int)
}

internal interface StringPersistence {
    fun load(): String?
    fun save(value: String)
}

internal data class HeartRateView(val bpm: Int, val fresh: Boolean)

internal class HeartRateStore(
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) {
    private class Reading(val bpm: Int, val observedAtMs: Long)

    @Volatile
    private var latest: Reading? = null

    fun record(bpm: Int) {
        latest = Reading(bpm, clockMs())
    }

    /** Last accepted BPM. `fresh` follows the 3s live window; stale readings stay visible. */
    fun view(): HeartRateView? {
        val reading = latest ?: return null
        val age = clockMs() - reading.observedAtMs
        if (age < 0L) return null
        return HeartRateView(reading.bpm, age <= FRESH_WINDOW_MS)
    }

    fun displayBpm(): Int? = view()?.takeIf { it.fresh }?.bpm

    companion object {
        const val FRESH_WINDOW_MS: Long = 3_000L
        const val MIN_BPM: Int = 30
        const val MAX_BPM: Int = 250
    }
}

internal object BrightnessLimits {
    const val MIN_PERCENT: Int = 0
    const val MAX_PERCENT: Int = 100
    const val MINIMUM_WINDOW_BRIGHTNESS: Float = 0.01f

    fun isValid(percent: Int): Boolean = percent in MIN_PERCENT..MAX_PERCENT

    fun toWindowBrightness(percent: Int): Float {
        if (percent <= MIN_PERCENT) return MINIMUM_WINDOW_BRIGHTNESS
        if (percent >= MAX_PERCENT) return 1f
        val level = percent / 100f
        return if (level < MINIMUM_WINDOW_BRIGHTNESS) MINIMUM_WINDOW_BRIGHTNESS else level
    }
}

internal class BrightnessStore(
    private val persistence: IntPersistence? = null,
) {
    @Volatile
    private var percent: Int? = persistence?.load()?.takeIf { BrightnessLimits.isValid(it) }

    @Volatile
    var revision: Int = 0
        private set

    fun percent(): Int? = percent

    @Synchronized
    fun record(value: Int) {
        if (!BrightnessLimits.isValid(value)) return
        percent = value
        revision += 1
        persistence?.save(value)
    }
}

internal class PairingTokenStore(
    private val persistence: StringPersistence,
    private val generator: () -> String = { PairingToken.generate() },
) {
    @Volatile
    private var token: String = loadOrCreate()

    fun token(): String = token

    @Synchronized
    fun regenerate(): String {
        val fresh = generator()
        persistence.save(fresh)
        token = fresh
        return fresh
    }

    @Synchronized
    private fun loadOrCreate(): String {
        val stored = PairingToken.normalize(persistence.load())
        if (stored != null) return stored
        val fresh = generator()
        persistence.save(fresh)
        return fresh
    }
}
