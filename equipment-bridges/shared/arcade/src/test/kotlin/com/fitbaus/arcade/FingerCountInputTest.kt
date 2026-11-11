// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FingerCountInputTest {
    private val ms = 1_000_000L
    private val input = FingerCountInput().also { it.configure(500 * ms) }
    private val gen = input.generation()
    private var seq = 0L

    private fun show(atMs: Long, vararg counts: Pair<Int, Int?>, rejection: FingerRejection? = null) {
        input.publish(observation(++seq, atMs, *counts, rejection = rejection), gen)
    }

    @Test
    fun confirmsOnlyAfterThreeConsistentObservationsOverThreeQuartersOfASecond() {
        show(0, 1 to 5, 2 to 2)
        val first = input.read(10 * ms)
        assertEquals(FingerInputState.Unstable, first.state)
        assertEquals(7, first.total)
        assertNull(first.stableTotal, "a single inference is never accepted")
        assertEquals(0f, first.progress)
        show(500, 1 to 5, 2 to 2)
        val second = input.read(510 * ms)
        assertEquals(FingerInputState.Unstable, second.state)
        assertTrue(second.progress > 0.5f && second.progress < 1f, "visible hold progress ${second.progress}")
        show(1000, 1 to 5, 2 to 2)
        val third = input.read(1010 * ms)
        assertEquals(FingerInputState.Stable, third.state)
        assertEquals(7, third.stableTotal)
        assertEquals(1f, third.progress)
        assertEquals(1000L, third.heldMs)
    }

    @Test
    fun threeFastObservationsStillNeedTheMinimumHold() {
        show(0, 1 to 3, 2 to 3)
        show(200, 1 to 3, 2 to 3)
        show(400, 1 to 3, 2 to 3)
        assertEquals(FingerInputState.Unstable, input.read(410 * ms).state)
        show(750, 1 to 3, 2 to 3)
        assertEquals(6, input.read(760 * ms).stableTotal)
    }

    @Test
    fun changingCountsRestartsConfirmation() {
        show(0, 1 to 5, 2 to 2)
        show(500, 1 to 5, 2 to 2)
        show(1000, 1 to 5, 2 to 1)
        val r = input.read(1010 * ms)
        assertEquals(FingerInputState.Unstable, r.state)
        assertEquals(6, r.total)
        assertEquals(0L, r.heldMs)
    }

    @Test
    fun swappingWhichHandShowsWhatRestartsConfirmation() {
        show(0, 1 to 5, 2 to 2)
        show(500, 1 to 5, 2 to 2)
        show(1000, 1 to 2, 2 to 5)
        assertEquals(FingerInputState.Unstable, input.read(1010 * ms).state)
    }

    @Test
    fun uncertainOrMissingObservationsResetConfirmation() {
        show(0, 1 to 4, 2 to 4)
        show(500, 1 to 4, 2 to 4)
        show(1000, 1 to 4, 2 to null)
        val uncertain = input.read(1010 * ms)
        assertEquals(FingerInputState.Uncertain, uncertain.state)
        assertNull(uncertain.total)
        show(1500, 1 to 4, 2 to 4)
        show(2000, 1 to 4, 2 to 4)
        assertEquals(FingerInputState.Unstable, input.read(2010 * ms).state)
        show(2500, 1 to 4)
        assertEquals(FingerInputState.OneHand, input.read(2510 * ms).state)
        show(3000, 1 to 4, 2 to 4)
        show(3500, 1 to 4, 2 to 4)
        show(4000, 1 to 4, 2 to 4)
        assertEquals(8, input.read(4010 * ms).stableTotal)
    }

    @Test
    fun aNewHandIdentityRestartsConfirmation() {
        show(0, 1 to 5, 2 to 2)
        show(500, 1 to 5, 2 to 2)
        show(1000, 1 to 5, 3 to 2)
        assertEquals(FingerInputState.Unstable, input.read(1010 * ms).state)
    }

    @Test
    fun aLongGapBetweenObservationsRestartsConfirmation() {
        show(0, 1 to 5, 2 to 5)
        show(500, 1 to 5, 2 to 5)
        show(1800, 1 to 5, 2 to 5)
        assertEquals(FingerInputState.Unstable, input.read(1810 * ms).state)
    }

    @Test
    fun staleObservationsNeverPublishATotal() {
        show(0, 1 to 5, 2 to 2)
        show(500, 1 to 5, 2 to 2)
        show(1000, 1 to 5, 2 to 2)
        assertEquals(7, input.read(1100 * ms).stableTotal)
        val stale = input.read(2600 * ms)
        assertEquals(FingerInputState.Stale, stale.state)
        assertNull(stale.total)
        assertNull(stale.stableTotal)
        assertTrue(stale.released)
    }

    @Test
    fun rejectedObservationsMapToTheirReason() {
        show(0, rejection = FingerRejection.NoHands)
        assertEquals(FingerInputState.NoHands, input.read(1 * ms).state)
        show(500, rejection = FingerRejection.Duplicate)
        val dup = input.read(501 * ms)
        assertEquals(FingerInputState.Rejected, dup.state)
        assertEquals(FingerRejection.Duplicate, dup.rejection)
    }

    @Test
    fun observationsFromAPreviousCameraSessionAreIgnored() {
        input.clear()
        input.publish(observation(1, 0, 1 to 5, 2 to 2), gen)
        assertEquals(FingerInputState.NoSignal, input.read(10 * ms).state)
        val next = input.generation()
        input.publish(observation(2, 0, 1 to 5, 2 to 2), next)
        assertEquals(FingerInputState.Unstable, input.read(10 * ms).state)
    }

    @Test
    fun everyTotalFromZeroToTenConfirms() {
        var t = 0L
        for (a in 0..5) {
            for (b in 0..5) {
                input.clear()
                val g = input.generation()
                repeat(3) {
                    input.publish(observation(++seq, t, 1 to a, 2 to b), g)
                    t += 500
                }
                assertEquals(a + b, input.read((t - 490) * ms).stableTotal, "$a + $b")
            }
        }
    }

    @Test
    fun statsTrackRecognitionRateAndRejections() {
        show(0, 1 to 5, 2 to 2)
        show(500, 1 to 5)
        show(1000, rejection = FingerRejection.NoHands)
        show(1500, 1 to 5, 2 to 2)
        val stats = input.stats()
        assertEquals(4L, stats.observations)
        assertEquals(2L, stats.accepted)
        assertEquals(0.5f, stats.recognitionRate)
        assertEquals(1, stats.rejections[FingerRejection.OneHand.ordinal])
        assertEquals(1, stats.rejections[FingerRejection.NoHands.ordinal])
    }
}
