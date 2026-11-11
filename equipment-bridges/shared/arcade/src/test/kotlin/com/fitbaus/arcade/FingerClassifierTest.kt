// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FingerClassifierTest {
    @Test
    fun realConsoleCameraLandmarksCountCorrectly() {
        assertEquals(14, RealHands.all.size)
        for (hand in RealHands.all) {
            val result = FingerClassifier.classify(hand.xy)
            assertEquals(hand.expected, result.count, "${hand.frame} ${hand.shape} ${result.describe()}")
            assertTrue(result.quality > 0f, "${hand.frame} ${hand.shape} quality")
        }
    }

    @Test
    fun realThumbIsJudgedSeparatelyFromFingers() {
        val thumbUp = RealHands.all.first { it.shape == "thumb_up" }
        val pointing = RealHands.all.first { it.shape == "pointing_up" }
        val victory = RealHands.all.first { it.shape == "victory" }
        assertEquals("Effff", FingerClassifier.classify(thumbUp.xy).describe())
        assertEquals("fEfff", FingerClassifier.classify(pointing.xy).describe())
        assertEquals("fEEff", FingerClassifier.classify(victory.xy).describe(), "a folded thumb tucked beside the fingers is not counted")
    }

    @Test
    fun everyFingerCombinationCountsZeroToFive() {
        for (mask in 0 until 32) {
            val poses = SyntheticHands.fromMask(mask)
            val expected = Integer.bitCount(mask)
            val result = FingerClassifier.classify(SyntheticHands.points(poses, 300f, 400f))
            assertEquals(expected, result.count, "mask $mask ${result.describe()}")
            for (i in 0 until 5) {
                val want = if (mask and (1 shl i) != 0) FingerState.Extended else FingerState.Folded
                assertEquals(want, result.states[i], "mask $mask finger $i")
            }
        }
    }

    @Test
    fun countIsInvariantToMirroringRotationAndDistance() {
        for (count in 0..5) {
            for (mirrored in listOf(false, true)) {
                for (degrees in listOf(-35f, -10f, 0f, 20f, 40f)) {
                    for (scale in listOf(55f, 100f, 180f)) {
                        val pts = SyntheticHands.points(SyntheticHands.showing(count), 320f, 300f, scale, degrees, mirrored)
                        assertEquals(count, FingerClassifier.classify(pts).count, "count $count mirrored $mirrored rot $degrees scale $scale")
                    }
                }
            }
        }
    }

    @Test
    fun partlyFoldedFingerIsUncertainAndYieldsNoCount() {
        val poses = SyntheticHands.showing(3)
        poses[2] = Pose.Partial
        val result = FingerClassifier.classify(SyntheticHands.points(poses, 300f, 400f))
        assertEquals(FingerState.Uncertain, result.states[2])
        assertNull(result.count)
        assertEquals(0f, result.quality)
    }

    @Test
    fun halfOpenThumbIsUncertain() {
        val poses = SyntheticHands.showing(0)
        poses[0] = Pose.Ambiguous
        val result = FingerClassifier.classify(SyntheticHands.points(poses, 300f, 400f))
        assertEquals(FingerState.Uncertain, result.states[FingerClassifier.THUMB])
        assertNull(result.count)
    }

    @Test
    fun degenerateLandmarksDoNotCrashOrCount() {
        val collapsed = FloatArray(42) { 100f }
        val result = FingerClassifier.classify(collapsed)
        assertNull(result.count, "a collapsed hand must not read as a closed fist")
    }
}
