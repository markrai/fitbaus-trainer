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
        var boostingSamples = 0

        fun sample(rpm: Int, gapMs: Long = 200L): CadenceReading {
            nowMs += gapMs
            seq += 1
            return boost.update(true, true, rpm, true, "t$seq", nowMs * 1_000_000L).also {
                last = it
                if (it.boosting) boostingSamples += 1
            }
        }

        fun repeatSame(gapMs: Long, rpm: Int? = last?.rpm): CadenceReading {
            nowMs += gapMs
            return boost.update(true, true, rpm, true, "t$seq", nowMs * 1_000_000L).also { last = it }
        }

        fun cruise(rpm: Int, ms: Long, gapMs: Long = 200L) {
            repeat((ms / gapMs).toInt()) { sample(rpm, gapMs) }
        }

        fun ramp(from: Int, to: Int, ms: Long, gapMs: Long = 200L) {
            val n = (ms / gapMs).toInt()
            for (i in 1..n) sample(from + Math.round((to - from) * i / n.toFloat()), gapMs)
        }

        fun surge(rpm: Int): CadenceReading {
            repeat(3) { sample(rpm) }
            return last!!
        }

        fun untilArmed(rpm: Int, maxMs: Long = 10_000L, gapMs: Long = 200L): Long {
            val start = nowMs
            while (!last!!.armed) {
                sample(rpm, gapMs)
                check(nowMs - start <= maxMs) { "never rearmed at $rpm: ${last!!.state} pace ${last!!.pace} spread ${last!!.paceSpread}" }
            }
            return nowMs - start
        }

        val baseline: Float
            get() = last!!.baseline

        val activations: Int
            get() = last!!.activations
    }

    private fun learned(rpm: Int, boost: CadenceBoost = CadenceBoost()): Ride {
        val ride = Ride(boost)
        ride.cruise(rpm, 4000)
        check(ride.last!!.state == CadenceState.Cruising && ride.last!!.armed)
        return ride
    }

    @Test
    fun baselineIsLearnedFromThreeSecondsOfSteadyPedaling() {
        val ride = Ride()
        assertEquals(CadenceState.NoTelemetry, ride.boost.update(true, true, null, false, null, 0).state)
        assertEquals(CadenceState.Establishing, ride.sample(60).state)
        ride.cruise(62, 2800)
        assertEquals(CadenceState.Establishing, ride.last!!.state, "a steady pace still needs three seconds of pedaling")
        assertFalse(ride.last!!.armed)
        val r = ride.sample(61)
        assertEquals(CadenceState.Cruising, r.state)
        assertTrue(r.armed)
        assertEquals(62f, r.baseline, 0.01f, "the trimmed mean of the steady window")
        assertEquals(r.baseline + 12f, r.threshold, 1e-3f)
    }

    @Test
    fun aConfirmedSurgeFrom60To76StartsAOneSecondDash() {
        val ride = learned(60)
        assertEquals(60f, ride.baseline, 0.01f)
        val first = ride.sample(76)
        assertFalse(first.boosting, "one sample is not enough")
        assertEquals(1, first.confirming)
        assertFalse(ride.sample(76).boosting, "still under the confirmation span")
        val lit = ride.sample(76)
        assertTrue(lit.boosting)
        assertEquals(1, lit.activations)
        assertFalse(lit.armed)
        assertEquals(60f, lit.baseline, 0.01f, "the pre-surge reference is kept")
        val still = ride.sample(76, 800)
        assertTrue(still.boosting)
        assertTrue(still.boostRemainingMs in 150L..250L)
        val ended = ride.sample(76, 200)
        assertFalse(ended.boosting, "the dash ends at 1 s even while cadence is still high")
        assertEquals(CadenceState.Recovering, ended.state)
        assertFalse(ended.armed)
        assertEquals(0L, ended.boostRemainingMs)
        assertEquals(1, ended.activations)
    }

    @Test
    fun holdingTheSurgedPaceBecomesTheNewBaselineAndNeverRetriggers() {
        val ride = learned(60)
        ride.surge(76)
        ride.cruise(76, 1000)
        assertEquals(CadenceState.Recovering, ride.last!!.state)
        val waited = ride.untilArmed(76)
        assertTrue(waited in 1800L..3000L, "rearmed $waited ms after the dash, not instantly and without slowing down")
        assertEquals(CadenceState.Cruising, ride.last!!.state)
        assertEquals(76f, ride.baseline, 0.01f)
        assertEquals(88f, ride.last!!.threshold, 0.01f)
        assertEquals(1, ride.activations, "rearming at the held cadence is not a new acceleration")
        val boostingBefore = ride.boostingSamples
        ride.cruise(76, 120_000)
        assertEquals(1, ride.activations, "two minutes at 76 never dash again")
        assertEquals(boostingBefore, ride.boostingSamples)
        assertTrue(ride.last!!.armed)
    }

    @Test
    fun riderCanClimb60To76To92AndKeepDashingWithoutReturningToTheStartingPace() {
        val ride = learned(60)
        assertTrue(ride.surge(76).boosting)
        ride.untilArmed(76)
        ride.cruise(76, 10_000)
        assertEquals(1, ride.activations)
        assertTrue(ride.surge(92).boosting, "a second surge from the new 76 pace")
        assertEquals(2, ride.activations)
        assertEquals(76f, ride.baseline, 0.01f)
        ride.untilArmed(92)
        assertEquals(92f, ride.baseline, 0.01f)
        ride.cruise(92, 10_000)
        assertEquals(2, ride.activations)
        ride.cruise(72, 3000)
        assertTrue(ride.last!!.armed)
        assertEquals(72f, ride.baseline, 0.01f, "a slower steady pace becomes the baseline too")
        assertEquals(2, ride.activations, "slowing down is never a dash")
        assertTrue(ride.surge(86).boosting, "a +14 surge from 72")
        assertEquals(3, ride.activations)
        ride.untilArmed(86)
        ride.cruise(86, 5000)
        assertEquals(3, ride.activations)
    }

    @Test
    fun slowingToASteadyLowerPaceRearmsAgainstIt() {
        val ride = learned(76)
        ride.cruise(72, 2400)
        assertEquals(72f, ride.baseline, 0.01f)
        ride.surge(84)
        assertEquals(1, ride.activations, "+12 over the new 72 pace, though only +8 over the old 76")
        ride.cruise(92, 1000)
        ride.cruise(72, 3000)
        assertTrue(ride.last!!.armed, "slowing straight after a dash settles a new pace too")
        assertEquals(72f, ride.baseline, 0.01f)
        ride.surge(86)
        assertEquals(2, ride.activations)
    }

    @Test
    fun aLongSessionOfSurgesAndRecoveriesNeverLocksTheBaseline() {
        val ride = learned(60)
        val paces = listOf(76, 70, 84, 79, 95, 88, 100, 90, 82, 97, 85, 66)
        var pace = 60
        for ((k, next) in paces.withIndex()) {
            assertTrue(ride.surge(pace + 15).boosting, "surge ${k + 1} from $pace")
            assertEquals(k + 1, ride.activations)
            ride.cruise(pace + 15, 1000)
            ride.untilArmed(next)
            assertEquals(next.toFloat(), ride.baseline, 0.01f, "settled at $next")
            ride.cruise(next, 6000)
            assertEquals(k + 1, ride.activations, "holding $next does not dash")
            pace = next
        }
        assertEquals(paces.size, ride.activations)
    }

    @Test
    fun aGradualClimbFrom60To80IsNotADash() {
        for (ms in listOf(20_000L, 10_000L, 6_000L)) {
            val ride = learned(60)
            ride.ramp(60, 80, ms)
            ride.cruise(80, 3000)
            assertEquals(0, ride.activations, "a climb over $ms ms is a pace change, not a burst")
            assertTrue(ride.last!!.armed)
            assertEquals(80f, ride.baseline, 1f, "the climbed pace became the reference")
            ride.surge(94)
            assertEquals(1, ride.activations, "and a real surge from 80 still dashes")
        }
    }

    @Test
    fun aQuickButNotInstantSurgeStillDashes() {
        val ride = learned(60)
        ride.ramp(60, 76, 1000)
        ride.cruise(76, 600)
        assertEquals(1, ride.activations, "a one-second spin-up (or smoothed bike RPM) is a burst")
    }

    @Test
    fun theSurgeMustRiseFromTheBaselineWithinTheRiseWindow() {
        val quick = learned(60)
        quick.cruise(68, 1400)
        quick.surge(74)
        assertEquals(1, quick.activations, "60 -> 68 -> 74 inside two seconds is one burst")
        val slow = learned(60)
        slow.cruise(68, 3000)
        assertEquals(68f, slow.baseline, 0.01f)
        slow.surge(74)
        assertEquals(0, slow.activations, "after settling at 68, 74 is only +6")
    }

    @Test
    fun aSubThresholdStepBecomesTheNewBaselineWithoutADash() {
        val ride = learned(60)
        ride.cruise(66, 10_000)
        assertEquals(66f, ride.baseline, 0.01f)
        assertEquals(0, ride.activations, "a +6 change is not a dash at +12")
        ride.surge(80)
        assertEquals(1, ride.activations)
    }

    @Test
    fun aSingleNoisySpikeNeverBoostsOrMovesTheBaseline() {
        val ride = learned(60)
        ride.sample(95)
        ride.sample(60)
        ride.sample(96)
        ride.sample(60)
        ride.cruise(60, 3000)
        assertEquals(0, ride.activations)
        assertEquals(60f, ride.baseline, 0.01f)
        assertTrue(ride.last!!.armed)
        ride.surge(76)
        assertEquals(1, ride.activations)
    }

    @Test
    fun noisyButSteadyCadenceSettlesOnceAndNeverDashes() {
        val noise = intArrayOf(75, 78, 76, 77, 75, 78, 77, 76)
        val ride = Ride()
        var i = 0
        fun noisy(ms: Long) = repeat((ms / 200).toInt()) { ride.sample(noise[i++ % noise.size]) }
        noisy(4000)
        assertTrue(ride.last!!.armed)
        var changes = 0
        var previous = ride.baseline
        repeat(300) {
            noisy(200)
            if (ride.baseline != previous) changes += 1
            previous = ride.baseline
            assertTrue(ride.baseline in 75f..78f)
        }
        assertEquals(0, ride.activations)
        assertTrue(changes <= 2, "the baseline stays put through 75-78 noise ($changes changes)")
        ride.surge(92)
        assertEquals(1, ride.activations)
        noisy(1000)
        var waited = 0L
        while (!ride.last!!.armed) {
            noisy(200)
            waited += 200
            check(waited < 6000) { "noise blocked rearming" }
        }
        assertTrue(waited <= 3000, "noisy cruising rearms like steady cruising ($waited ms)")
        assertEquals(1, ride.activations)
    }

    @Test
    fun anErraticRiderIsNotLockedOut() {
        val ride = Ride()
        var high = false
        fun erratic(ms: Long) = repeat((ms / 200).toInt()) { high = !high; ride.sample(if (high) 70 else 60) }
        erratic(5000)
        assertEquals(CadenceState.Establishing, ride.last!!.state, "60/70 alternation is not a steady pace")
        erratic(1600)
        assertEquals(CadenceState.Cruising, ride.last!!.state, "the fallback accepts the pace after about six seconds")
        assertEquals(65f, ride.baseline, 1f, "the trimmed mean sits between the two cadences")
        erratic(10_000)
        assertEquals(0, ride.activations)
        ride.surge(80)
        assertEquals(1, ride.activations)
        ride.cruise(80, 1000)
        erratic(7000)
        assertTrue(ride.last!!.armed, "and recovery falls back the same way")
        assertEquals(1, ride.activations)
    }

    @Test
    fun irregularSampleIntervalsStillLearnDashAndRearm() {
        val gaps = longArrayOf(120, 380, 250, 610, 90, 330, 450, 180)
        val ride = Ride()
        var g = 0
        fun hold(rpm: Int, ms: Long) {
            val end = ride.nowMs + ms
            while (ride.nowMs < end) ride.sample(rpm, gaps[g++ % gaps.size])
        }
        hold(60, 5000)
        assertTrue(ride.last!!.armed)
        assertEquals(60f, ride.baseline, 0.01f)
        hold(76, 1500)
        assertEquals(1, ride.activations)
        hold(76, 4000)
        assertTrue(ride.last!!.armed)
        assertEquals(76f, ride.baseline, 0.01f)
        hold(76, 30_000)
        assertEquals(1, ride.activations)
        hold(92, 1500)
        assertEquals(2, ride.activations)
        val sparse = Ride()
        repeat(8) { sparse.sample(60, 700) }
        assertTrue(sparse.last!!.armed, "about 1.4 Hz telemetry still learns")
        repeat(3) { sparse.sample(76, 700) }
        assertEquals(1, sparse.activations)
        repeat(5) { sparse.sample(76, 700) }
        assertTrue(sparse.last!!.armed)
        repeat(20) { sparse.sample(76, 700) }
        assertEquals(1, sparse.activations)
    }

    @Test
    fun staleOrRepeatedTelemetryNeverBoosts() {
        val ride = learned(60)
        ride.sample(80)
        repeat(10) { ride.repeatSame(150) }
        assertEquals(0, ride.last!!.activations, "the same observation repeated is one sample")
        repeat(3) { ride.repeatSame(20, rpm = 95) }
        assertEquals(0, ride.last!!.activations, "a new value under the same observation time is ignored")
        val stale = ride.repeatSame(2500)
        assertEquals(CadenceState.Stale, stale.state)
        assertEquals(CadenceState.NoTelemetry, ride.boost.update(false, false, 80, true, "x", (ride.nowMs + 10) * 1_000_000L).state)
        assertEquals(0, stale.activations)
        val notCurrent = ride.boost.update(true, true, 90, false, "late", (ride.nowMs + 20) * 1_000_000L)
        assertEquals(0, notCurrent.activations)
    }

    @Test
    fun repeatedObservationsDoNotAdvanceRecovery() {
        val ride = learned(60)
        ride.surge(76)
        ride.cruise(76, 1000)
        assertEquals(CadenceState.Recovering, ride.last!!.state)
        val samples = ride.last!!.paceSamples
        repeat(12) { ride.repeatSame(150) }
        assertEquals(CadenceState.Recovering, ride.last!!.state)
        assertEquals(samples, ride.last!!.paceSamples, "the same observation is never fresh evidence")
        assertFalse(ride.last!!.armed)
    }

    @Test
    fun staleTelemetryCancelsADashAndHeldCadenceDoesNotRetriggerAfterIt() {
        val ride = learned(60)
        ride.surge(74)
        assertTrue(ride.last!!.boosting)
        val stale = ride.repeatSame(2500)
        assertEquals(CadenceState.Stale, stale.state)
        assertFalse(stale.boosting)
        assertFalse(stale.armed)
        assertEquals(0L, stale.boostRemainingMs)
        ride.cruise(74, 1000)
        assertFalse(ride.last!!.boosting, "returning from stale at the same high cadence is not a new dash")
        assertEquals(CadenceState.Recovering, ride.last!!.state)
        ride.untilArmed(74)
        ride.cruise(74, 10_000)
        assertEquals(1, ride.activations)
    }

    @Test
    fun telemetryReturningAtAnElevatedCadenceIsNotADash() {
        val ride = learned(60)
        assertEquals(CadenceState.Stale, ride.repeatSame(3000).state)
        ride.cruise(90, 1000)
        assertEquals(0, ride.activations, "a stale gap hides how the rider got to 90")
        assertEquals(CadenceState.Recovering, ride.last!!.state)
        ride.untilArmed(90)
        assertEquals(90f, ride.baseline, 0.01f)
        ride.cruise(90, 5000)
        assertEquals(0, ride.activations)
        ride.surge(106)
        assertEquals(1, ride.activations)
        val switched = learned(60)
        switched.sample(90, 5000)
        switched.cruise(90, 1000)
        assertEquals(0, switched.activations, "a game switch (no updates at all) is the same as a stale gap")
    }

    @Test
    fun stoppingAndResumingRequireSettling() {
        val ride = learned(60)
        val stop = ride.sample(0)
        assertEquals(CadenceState.Stopped, stop.state)
        assertFalse(stop.pedaling)
        assertFalse(stop.armed)
        ride.sample(80)
        ride.sample(80)
        ride.sample(80)
        assertEquals(0, ride.activations, "spinning back up is not a boost")
        assertEquals(CadenceState.Recovering, ride.last!!.state)
        assertTrue(ride.last!!.pedaling)
        ride.cruise(60, 2600)
        assertTrue(ride.last!!.armed, "a short stop keeps playing and settles on the resumed pace")
        ride.surge(76)
        assertEquals(1, ride.activations)
    }

    @Test
    fun aLongStopRelearnsTheBaseline() {
        val ride = learned(60)
        repeat(60) { ride.sample(0) }
        assertEquals(CadenceState.Establishing, ride.sample(90).state)
        ride.cruise(90, 3000)
        assertEquals(90f, ride.baseline, 0.01f)
    }

    @Test
    fun aShortDipDuringADashNeitherCancelsNorExtendsIt() {
        val ride = learned(60)
        val lit = ride.surge(76)
        assertTrue(lit.boosting)
        val dip = ride.sample(64)
        assertTrue(dip.boosting, "a dip below the threshold does not cancel the dash")
        assertTrue(dip.boostRemainingMs in 750L..850L)
        assertTrue(ride.sample(76).boosting)
        assertTrue(ride.sample(76, 400).boosting)
        val ended = ride.sample(76, 200)
        assertFalse(ended.boosting, "it still ends one second after it lit")
        assertEquals(1, ended.activations)
    }

    @Test
    fun aHigherPlateauDuringRecoveryNeverCreatesAPhantomDash() {
        val ride = learned(60)
        ride.surge(76)
        ride.cruise(76, 1400)
        assertEquals(CadenceState.Recovering, ride.last!!.state)
        ride.cruise(95, 1000)
        assertEquals(1, ride.activations, "a jump while recovering is not armed")
        ride.untilArmed(95)
        assertEquals(95f, ride.baseline, 0.01f)
        ride.cruise(95, 30_000)
        assertEquals(1, ride.activations)
    }

    @Test
    fun anActiveDashDoesNotContaminateThePreSurgeReferenceButLaterCruisingDoes() {
        val ride = learned(60)
        ride.surge(80)
        repeat(4) {
            ride.sample(80)
            assertEquals(60f, ride.baseline, 0.01f, "dash samples never move the reference")
        }
        ride.sample(80)
        assertEquals(CadenceState.Recovering, ride.last!!.state)
        assertEquals(60f, ride.baseline, 0.01f)
        ride.untilArmed(80)
        assertEquals(80f, ride.baseline, 0.01f, "steady cruising after the dash is the new reference")
    }

    @Test
    fun aPendingSurgeFreezesTheBaseline() {
        val config = CadenceConfig(confirmSamples = 12, confirmNanos = 2_200_000_000L)
        val ride = learned(60, CadenceBoost(config))
        repeat(11) {
            ride.sample(76)
            assertEquals(60f, ride.baseline, 0.01f, "the window is steady at 76, but the surge is pending")
            assertFalse(ride.last!!.boosting)
        }
        ride.sample(76)
        assertTrue(ride.last!!.boosting, "so it still confirms against 60")
    }

    @Test
    fun relativeThresholdIsBounded() {
        assertEquals(6, CadenceConfig(deltaRpm = 2).delta)
        assertEquals(25, CadenceConfig(deltaRpm = 40).delta)
        val ride = learned(60, CadenceBoost(CadenceConfig(deltaRpm = 8)))
        ride.cruise(69, 1000)
        assertEquals(1, ride.last!!.activations, "a lower threshold boosts without sprinting")
    }
}
