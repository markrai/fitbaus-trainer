// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FlakControlsTest {
    private val ms = 1_000_000L

    private fun nose(y: Float, atMs: Long, source: HandSource = HandSource.Camera) = HandPosition(0.5f, y, 0.9f, atMs * ms, source)

    private fun calibrated(neutral: Float = 0.4f): Pair<VerticalFaceControl, Long> {
        val control = VerticalFaceControl()
        var t = 0L
        while (!control.calibrated) {
            control.update(nose(neutral, t), t * ms)
            t += 100
        }
        return control to t
    }

    @Test
    fun calibrationNeedsOneSecondOfFreshTracking() {
        val control = VerticalFaceControl()
        assertEquals(FaceControlState.Calibrating, control.update(nose(0.4f, 0), 0).state)
        for (t in 100L..900L step 100) assertEquals(FaceControlState.Calibrating, control.update(nose(0.4f, t), t * ms).state)
        val done = control.update(nose(0.4f, 1000), 1000 * ms)
        assertEquals(FaceControlState.Tracking, done.state)
        assertEquals(0.4f, done.neutralY, 1e-4f)
        assertEquals(0.5f, done.target, 1e-4f, "neutral head = middle of the flight band")
    }

    @Test
    fun losingTheFaceDuringCalibrationStartsOver() {
        val control = VerticalFaceControl()
        for (t in 0L..500L step 100) control.update(nose(0.3f, t), t * ms)
        control.update(nose(0.3f, 500, HandSource.Lost), 600 * ms)
        for (t in 700L..1500L step 100) control.update(nose(0.5f, t), t * ms)
        val r = control.update(nose(0.5f, 1700), 1700 * ms)
        assertEquals(FaceControlState.Tracking, r.state)
        assertEquals(0.5f, r.neutralY, 1e-4f, "samples from before the loss are discarded")
    }

    @Test
    fun headUpMovesTheJetUpWithADeadZoneAndClamping() {
        val (control, t) = calibrated(0.4f)
        assertEquals(0.5f, control.update(nose(0.405f, t), t * ms).target, 1e-4f, "small head bob inside the dead zone")
        val up = control.update(nose(0.35f, t + 100), (t + 100) * ms).target
        assertEquals(0.5f + (-0.05f + 0.008f) * 6f, up, 1e-4f)
        assertTrue(up < 0.5f, "nose up = jet up (0 is the top of the band)")
        val down = control.update(nose(0.45f, t + 200), (t + 200) * ms).target
        assertTrue(down > 0.5f)
        assertEquals(0f, control.update(nose(0.2f, t + 300), (t + 300) * ms).target)
        assertEquals(1f, control.update(nose(0.7f, t + 400), (t + 400) * ms).target)
    }

    @Test
    fun aboutEightPercentOfFrameHeightCoversHalfTheBandAtMediumSensitivity() {
        val (control, _) = calibrated(0.4f)
        assertEquals(0f, control.targetFor(0.4f - 0.0914f), 0.01f)
        control.setGain(11f)
        assertTrue(control.targetFor(0.35f) < 0.1f, "very high sensitivity needs a smaller nod")
        control.setGain(4f)
        assertTrue(control.targetFor(0.35f) > 0.3f)
    }

    @Test
    fun staleOrLostFaceNeverSteers() {
        val (control, t) = calibrated()
        val stale = control.update(nose(0.2f, t), (t + 500) * ms)
        assertEquals(FaceControlState.Lost, stale.state)
        assertEquals(0.5f, stale.target)
        assertEquals(FaceControlState.Lost, control.update(nose(0.2f, t, HandSource.Lost), (t + 10) * ms).state)
        assertEquals(FaceControlState.Lost, control.update(nose(0.2f, t, HandSource.Touch), (t + 10) * ms).state)
    }

    @Test
    fun stableTimeRestartsAfterALoss() {
        val (control, t) = calibrated()
        val before = control.update(nose(0.4f, t + 300), (t + 300) * ms)
        assertTrue(before.stableMs > 0)
        control.update(nose(0.4f, t + 300, HandSource.Lost), (t + 400) * ms)
        assertEquals(0L, control.update(nose(0.4f, t + 500), (t + 500) * ms).stableMs)
    }

    @Test
    fun recalibrateUsesTheNewNeutral() {
        val (control, t) = calibrated(0.4f)
        control.recalibrate()
        var now = t
        var r = control.update(nose(0.3f, now), now * ms)
        while (r.state != FaceControlState.Tracking) {
            now += 100
            r = control.update(nose(0.3f, now), now * ms)
        }
        assertEquals(0.3f, r.neutralY, 1e-4f)
    }

    private class Ride(val boost: CadenceBoost = CadenceBoost()) {
        var nowMs = 0L
        var seq = 0
        var last: CadenceReading? = null

        fun sample(rpm: Int, gapMs: Long = 200L): CadenceReading {
            nowMs += gapMs
            seq += 1
            return boost.update(true, true, rpm, true, "t$seq", nowMs * 1_000_000L).also { last = it }
        }

        fun repeatSame(gapMs: Long): CadenceReading {
            nowMs += gapMs
            return boost.update(true, true, last?.rpm, true, "t$seq", nowMs * 1_000_000L)
        }

        fun cruise(rpm: Int, seconds: Float) {
            repeat((seconds * 5).toInt()) { sample(rpm) }
        }
    }

    @Test
    fun baselineIsLearnedFromThreeSecondsOfPedaling() {
        val ride = Ride()
        assertEquals(CadenceState.NoTelemetry, ride.boost.update(true, true, null, false, null, 0).state)
        assertEquals(CadenceState.Establishing, ride.sample(60).state)
        ride.cruise(62, 2.9f)
        val r = ride.sample(61)
        assertEquals(CadenceState.Cruising, r.state)
        assertEquals(61.5f, r.baseline, 1.0f)
        assertEquals(r.baseline + 12f, r.threshold, 1e-3f)
    }

    @Test
    fun aConfirmedSurgeStartsAOneSecondDashThatEndsEvenIfCadenceStaysHigh() {
        val ride = Ride()
        ride.cruise(60, 4f)
        val high = (ride.last!!.baseline + 14).toInt()
        assertFalse(ride.sample(high).boosting, "one sample is not enough")
        assertFalse(ride.sample(high).boosting, "still under the confirmation span")
        val lit = ride.sample(high)
        assertTrue(lit.boosting)
        assertEquals(1, lit.activations)
        assertFalse(lit.armed)
        val still = ride.sample(high, 800)
        assertTrue(still.boosting)
        assertTrue(still.boostRemainingMs in 150L..250L)
        val ended = ride.sample(high, 200)
        assertFalse(ended.boosting, "dash ends at 1 s even while cadence is still high")
        assertEquals(CadenceState.Cruising, ended.state)
        assertEquals(0L, ended.boostRemainingMs)
        ride.cruise(high, 2f)
        assertFalse(ride.last!!.boosting)
        assertEquals(1, ride.last!!.activations, "held cadence never extends or retriggers the dash")
        assertFalse(ride.last!!.armed)
    }

    @Test
    fun aNewDashRequiresDroppingBelowTheHysteresisBandThenAnotherSurge() {
        val ride = Ride()
        ride.cruise(60, 4f)
        val high = (ride.last!!.baseline + 14).toInt()
        val threshold = ride.last!!.threshold
        repeat(3) { ride.sample(high) }
        ride.sample(high, 1000)
        assertFalse(ride.last!!.boosting)
        ride.cruise((threshold - 2f).toInt(), 1f)
        repeat(3) { ride.sample(high) }
        assertEquals(1, ride.last!!.activations, "the hysteresis band does not rearm")
        assertFalse(ride.last!!.armed)
        ride.cruise(60, 1f)
        assertTrue(ride.last!!.armed, "a genuine drop below the band rearms")
        repeat(3) { ride.sample(high) }
        assertTrue(ride.last!!.boosting)
        assertEquals(2, ride.last!!.activations)
    }

    @Test
    fun aSingleNoisySpikeNeverBoosts() {
        val ride = Ride()
        ride.cruise(60, 4f)
        ride.sample(95)
        ride.sample(60)
        ride.sample(96)
        ride.sample(60)
        assertEquals(0, ride.last!!.activations)
    }

    @Test
    fun staleOrRepeatedTelemetryNeverBoosts() {
        val ride = Ride()
        ride.cruise(60, 4f)
        ride.sample(80)
        repeat(10) { ride.repeatSame(200) }
        assertEquals(0, ride.last!!.activations, "the same observation repeated is one sample")
        val stale = ride.repeatSame(2500)
        assertEquals(CadenceState.Stale, stale.state)
        assertEquals(CadenceState.NoTelemetry, ride.boost.update(false, false, 80, true, "x", (ride.nowMs + 10) * 1_000_000L).state)
        assertEquals(0, stale.activations)
        val notCurrent = ride.boost.update(true, true, 90, false, "late", (ride.nowMs + 20) * 1_000_000L)
        assertEquals(0, notCurrent.activations)
    }

    @Test
    fun staleTelemetryCancelsADashAndHeldCadenceDoesNotRetriggerAfterIt() {
        val ride = Ride()
        ride.cruise(60, 4f)
        val high = (ride.last!!.baseline + 14).toInt()
        repeat(3) { ride.sample(high) }
        assertTrue(ride.last!!.boosting)
        val stale = ride.repeatSame(2500)
        assertEquals(CadenceState.Stale, stale.state)
        assertFalse(stale.boosting)
        assertEquals(0L, stale.boostRemainingMs)
        ride.cruise(high, 1f)
        assertFalse(ride.last!!.boosting, "returning from stale at the same high cadence is not a new dash")
        assertEquals(1, ride.last!!.activations)
    }

    @Test
    fun boostingDoesNotRaiseTheBaseline() {
        val ride = Ride()
        ride.cruise(60, 4f)
        val before = ride.last!!.baseline
        ride.cruise((before + 20).toInt(), 6f)
        assertEquals(before, ride.last!!.baseline, 0.01f, "boost and cooldown samples are excluded")
    }

    @Test
    fun baselineFollowsASteadyChangeOnlySlowly() {
        val ride = Ride()
        ride.cruise(60, 4f)
        ride.cruise(66, 10f)
        val b = ride.last!!.baseline
        assertTrue(b > 61f && b < 66f, "baseline $b drifts toward the new steady cadence")
        assertEquals(0, ride.last!!.activations, "a +6 change is not a boost at +12")
    }

    @Test
    fun stoppingAndResumingRequireSettling() {
        val ride = Ride()
        ride.cruise(60, 4f)
        val stop = ride.sample(0)
        assertEquals(CadenceState.Stopped, stop.state)
        assertFalse(stop.pedaling)
        ride.sample(80)
        ride.sample(80)
        ride.sample(80)
        assertEquals(0, ride.last!!.activations, "spinning back up is not a boost")
        ride.cruise(60, 2f)
        ride.cruise(76, 1f)
        assertEquals(1, ride.last!!.activations)
    }

    @Test
    fun aLongStopRelearnsTheBaseline() {
        val ride = Ride()
        ride.cruise(60, 4f)
        repeat(60) { ride.sample(0) }
        assertEquals(CadenceState.Establishing, ride.sample(90).state)
    }

    @Test
    fun relativeThresholdIsBounded() {
        assertEquals(6, CadenceConfig(deltaRpm = 2).delta)
        assertEquals(25, CadenceConfig(deltaRpm = 40).delta)
        val ride = Ride(CadenceBoost(CadenceConfig(deltaRpm = 8)))
        ride.cruise(60, 4f)
        ride.cruise(69, 1f)
        assertEquals(1, ride.last!!.activations, "a lower threshold boosts without sprinting")
    }
}
