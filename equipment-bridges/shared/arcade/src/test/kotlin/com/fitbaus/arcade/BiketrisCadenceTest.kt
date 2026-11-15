// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.math.abs

class BiketrisCadenceTest {
    private val cfg = CadenceGravityConfig()
    private val level1 = BiketrisConfig().gravitySeconds(1)

    private class Feed(val gravity: CadenceGravity = CadenceGravity()) {
        var nanos = 5_000_000_000L
        var serial = 0
        var connected = true
        var initialized = true
        var current = true

        fun sample(rpm: Int?, ms: Long = 250L, newSample: Boolean = true): Float {
            nanos += ms * 1_000_000L
            if (newSample) serial += 1
            return gravity.update(connected, initialized, rpm, current, "s$serial", nanos)
        }

        fun hold(rpm: Int?, ms: Long, everyMs: Long = 250L) {
            var left = ms
            while (left > 0) {
                var tick = 0L
                while (tick < everyMs && left > 0) {
                    nanos += 33_000_000L
                    gravity.update(connected, initialized, rpm, current, "s$serial", nanos)
                    tick += 33L
                    left -= 33L
                }
                serial += 1
            }
        }

        fun missing(ms: Long) {
            var left = ms
            while (left > 0) {
                nanos += 33_000_000L
                gravity.update(false, false, null, false, null, nanos)
                left -= 33L
            }
        }
    }

    @Test
    fun defaultModeIsPedalToSlowAndKeysRoundTrip() {
        assertEquals(CadenceMode.PedalToSlow, CadenceMode.DEFAULT)
        assertEquals(CadenceMode.PedalToSlow, CadenceGravity().mode)
        assertEquals(CadenceMode.PedalToSlow, CadenceMode.fromKey(null))
        assertEquals(CadenceMode.PedalToSlow, CadenceMode.fromKey("garbage"))
        for (mode in CadenceMode.values()) assertEquals(mode, CadenceMode.fromKey(mode.key))
        assertEquals(listOf("PEDAL TO SLOW", "PEDAL TO SPEED UP"), CadenceMode.values().map { it.label })
    }

    @Test
    fun referenceTableAtLevelOne() {
        assertEquals(0.72f, level1, 1e-4f)
        val expected = mapOf(
            40 to (0.54f to 0.90f),
            70 to (0.72f to 0.72f),
            100 to (0.90f to 0.54f),
        )
        for ((rpm, pair) in expected) {
            assertEquals(pair.first, cfg.interval(level1, cfg.multiplier(CadenceMode.PedalToSlow, rpm.toFloat())), 1e-4f, "slow at $rpm")
            assertEquals(pair.second, cfg.interval(level1, cfg.multiplier(CadenceMode.PedalToSpeedUp, rpm.toFloat())), 1e-4f, "speed at $rpm")
        }
    }

    @Test
    fun mappingIsMonotonicClampedAndNeutralAtSeventy() {
        var lastSlow = -1f
        var lastSpeed = 10f
        for (rpm in 0..200) {
            val slow = cfg.multiplier(CadenceMode.PedalToSlow, rpm.toFloat())
            val speed = cfg.multiplier(CadenceMode.PedalToSpeedUp, rpm.toFloat())
            assertTrue(slow >= lastSlow, "slow non-decreasing at $rpm")
            assertTrue(speed <= lastSpeed, "speed non-increasing at $rpm")
            lastSlow = slow
            lastSpeed = speed
        }
        assertTrue(cfg.multiplier(CadenceMode.PedalToSlow, 90f) > cfg.multiplier(CadenceMode.PedalToSlow, 60f))
        assertTrue(cfg.multiplier(CadenceMode.PedalToSpeedUp, 90f) < cfg.multiplier(CadenceMode.PedalToSpeedUp, 60f))
        assertEquals(0.75f, cfg.multiplier(CadenceMode.PedalToSlow, 0f), 1e-6f)
        assertEquals(1.25f, cfg.multiplier(CadenceMode.PedalToSlow, 180f), 1e-6f)
        assertEquals(1.25f, cfg.multiplier(CadenceMode.PedalToSpeedUp, 0f), 1e-6f)
        assertEquals(0.75f, cfg.multiplier(CadenceMode.PedalToSpeedUp, 180f), 1e-6f)
        for (mode in CadenceMode.values()) assertEquals(1f, cfg.multiplier(mode, 70f), 1e-6f)
        assertEquals(cfg.minIntervalSeconds, cfg.interval(0.05f, 0.75f), 1e-6f, "absolute floor")
    }

    @Test
    fun steadyCadenceConvergesWithoutOvershoot() {
        val f = Feed()
        var last = 1f
        var t = 0L
        while (t < 6000L) {
            f.hold(100, 250L)
            val now = f.gravity.appliedMultiplier
            assertTrue(now >= last - 1e-5f, "monotonic rise at $t ms")
            assertTrue(now <= 1.25f + 1e-5f, "never overshoots")
            last = now
            t += 250L
        }
        assertEquals(1.25f, f.gravity.appliedMultiplier, 0.01f)
        assertEquals(100f, f.gravity.filteredRpm, 1f)
    }

    @Test
    fun sustainedChangeIsPerceptibleWithinAboutASecondAndReverses() {
        val f = Feed()
        f.hold(70, 3000L)
        assertEquals(1f, f.gravity.appliedMultiplier, 0.01f)
        f.hold(100, 1250L)
        assertTrue(f.gravity.appliedMultiplier > 1.12f, "clear effect after ~1 s: ${f.gravity.appliedMultiplier}")
        f.hold(100, 4000L)
        f.hold(40, 4000L)
        assertEquals(0.75f, f.gravity.appliedMultiplier, 0.02f, "slower pedaling reverses it")
    }

    @Test
    fun zeroRpmIsAValidLowCadenceSample() {
        val f = Feed()
        f.hold(0, 5000L)
        assertEquals(CadenceStatus.Live, f.gravity.status)
        assertEquals(0, f.gravity.rawRpm)
        assertEquals(0f, f.gravity.filteredRpm, 1f, "displayed cadence reaches zero")
        assertEquals(0.75f, f.gravity.appliedMultiplier, 0.01f)
    }

    @Test
    fun duplicateSamplesAddTimeNotWeight() {
        val dup = Feed()
        val fresh = Feed()
        dup.sample(100)
        fresh.sample(100)
        repeat(30) {
            dup.sample(100, ms = 33L, newSample = false)
            fresh.sample(100, ms = 33L, newSample = true)
        }
        assertEquals(1, dup.gravity.samples, "a repeated timestamp is not a new observation")
        assertEquals(31, fresh.gravity.samples)
        assertEquals(fresh.gravity.filteredRpm, dup.gravity.filteredRpm, 1e-3f, "smoothing depends on time only")
        val notCurrent = Feed()
        notCurrent.current = false
        notCurrent.sample(100)
        assertEquals(0, notCurrent.gravity.samples, "a sample flagged not current is ignored")
    }

    @Test
    fun staleTelemetryReturnsToNeutralAndNeverFreezes() {
        val f = Feed()
        f.hold(100, 5000L)
        assertTrue(f.gravity.appliedMultiplier > 1.2f)
        var t = 0L
        while (t < 8000L) {
            f.sample(100, ms = 33L, newSample = false)
            t += 33L
        }
        assertEquals(CadenceStatus.Stale, f.gravity.status)
        assertEquals(1f, f.gravity.appliedMultiplier, 0.02f, "an old high sample keeps no advantage")
    }

    @Test
    fun disconnectionAndRecoveryAreSmooth() {
        val f = Feed()
        f.hold(40, 5000L)
        f.connected = false
        val before = f.gravity.appliedMultiplier
        f.sample(40, ms = 33L)
        assertEquals(CadenceStatus.NoTelemetry, f.gravity.status)
        assertTrue(abs(f.gravity.appliedMultiplier - before) < 0.02f, "no step on disconnect")
        f.missing(8000L)
        assertEquals(1f, f.gravity.appliedMultiplier, 0.02f)
        f.connected = true
        f.sample(100, ms = 33L)
        assertTrue(f.gravity.appliedMultiplier < 1.03f, "recovery eases in")
        f.hold(100, 5000L)
        assertEquals(1.25f, f.gravity.appliedMultiplier, 0.02f, "and reaches the correct interval")
        val uninit = Feed()
        uninit.initialized = false
        uninit.sample(90)
        assertEquals(CadenceStatus.NoTelemetry, uninit.gravity.status)
        assertEquals(0, uninit.gravity.samples)
    }

    @Test
    fun aSingleSpikeOnlyNudgesTheMultiplier() {
        val f = Feed()
        f.hold(70, 4000L)
        f.hold(250, 250L)
        var peak = 1f
        repeat(10) {
            f.hold(70, 66L, everyMs = 250L)
            peak = maxOf(peak, f.gravity.appliedMultiplier)
        }
        assertTrue(peak - 1f < 0.06f, "one 250 ms spike peaks at x$peak")
        f.hold(70, 3000L)
        assertEquals(1f, f.gravity.appliedMultiplier, 0.01f)
    }

    @Test
    fun modeSwitchTransitionsSmoothly() {
        val f = Feed()
        f.hold(100, 5000L)
        val before = f.gravity.appliedMultiplier
        f.gravity.mode = CadenceMode.PedalToSpeedUp
        f.sample(100, ms = 33L)
        assertTrue(before - f.gravity.appliedMultiplier < 0.1f, "no jump on the switch frame")
        f.hold(100, 3000L)
        assertEquals(0.75f, f.gravity.appliedMultiplier, 0.01f)
    }

    @Test
    fun longGapsArePacedAndPausesDoNotJump() {
        val f = Feed()
        f.hold(70, 2000L)
        f.sample(100, ms = 60_000L)
        assertTrue(f.gravity.appliedMultiplier < 1.1f, "a minute-long gap counts as one capped step")
        val g = Feed()
        g.hold(70, 2000L)
        g.gravity.pauseClock()
        g.sample(100, ms = 60_000L)
        assertEquals(1f, g.gravity.appliedMultiplier, 1e-4f, "the first update after a pause only arms the clock")
    }

    @Test
    fun selectorSegmentsHaveDistinctHitRegions() {
        val side = CadenceSelectorLayout()
        side.set(100f, 200f, 400f, 50f, stacked = false)
        assertEquals(CadenceMode.PedalToSlow, side.hit(110f, 220f))
        assertEquals(CadenceMode.PedalToSlow, side.hit(299f, 249f))
        assertEquals(CadenceMode.PedalToSpeedUp, side.hit(300f, 200f))
        assertEquals(CadenceMode.PedalToSpeedUp, side.hit(499f, 220f))
        assertNull(side.hit(99f, 220f))
        assertNull(side.hit(500f, 220f))
        assertNull(side.hit(200f, 199f))
        assertNull(side.hit(200f, 250f))
        val stacked = CadenceSelectorLayout()
        stacked.set(0f, 0f, 200f, 100f, stacked = true)
        assertEquals(CadenceMode.PedalToSlow, stacked.hit(150f, 10f))
        assertEquals(CadenceMode.PedalToSpeedUp, stacked.hit(150f, 60f))
        val hidden = CadenceSelectorLayout()
        assertFalse(hidden.visible)
        assertNull(hidden.hit(0f, 0f))
    }

    @Test
    fun theRotateButtonIsGoneAndTheSelectorPersists() {
        val view = File("src/main/kotlin/com/fitbaus/arcade/BiketrisView.kt").readText()
        for (gone in listOf("rotateRect", "rotatePressed", "requestTouchRotation", "TAP ROTATE", "canvas.drawText(\"ROTATE\", ")) {
            assertFalse(view.contains(gone), gone)
        }
        assertTrue(view.contains("selector.hit(x, y)"))
        assertTrue(view.contains("CADENCE_MODE_KEY = \"biketris_cadence_mode\""))
        assertTrue(view.contains("prefs?.edit()?.putString(CADENCE_MODE_KEY, mode.key)?.apply()"))
        assertTrue(view.contains("CadenceMode.fromKey(prefs?.getString(CADENCE_MODE_KEY, null))"))
        val controls = File("src/main/kotlin/com/fitbaus/arcade/BiketrisControls.kt").readText()
        assertFalse(controls.contains("requestTouchRotation"))
        val sources = listOf("BiketrisCadence.kt", "BiketrisControls.kt", "BiketrisView.kt", "BiketrisGame.kt").joinToString("\n") {
            File("src/main/kotlin/com/fitbaus/arcade/$it").readText()
        }
        for (forbidden in listOf("Thread(", "Timer(", "Executor", "Handler(", "Resistance", "UsbManager")) {
            assertFalse(sources.contains(forbidden), forbidden)
        }
    }
}
