// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FingerTrackerTest {
    private val frame = ByteArray(640 * 480 * 3 / 2)
    private val models = FakeHandModels()
    private val published = ArrayList<FingerObservation>()
    private val tracker = FingerTracker(models, { published += it })
    private var now = 0L

    private fun update(): FingerObservation {
        now += 500_000_000L
        assertNull(tracker.process(frame, 640, 480, now), "finger tracking never drives a control point")
        return published.last()
    }

    private fun hand(count: Int, x: Float, presence: Float = 0.98f, mirrored: Boolean = false, scale: Float = 100f) =
        SceneHand(SyntheticHands.points(SyntheticHands.showing(count), x, 400f, scale, mirrored = mirrored), presence)

    @Test
    fun twoHandsAreCountedIndependentlyAndOrderedAsThePlayerSeesThem() {
        models.show(hand(5, 150f), hand(2, 480f, mirrored = true))
        val obs = update()
        assertNull(obs.rejection)
        assertTrue(obs.accepted)
        assertEquals(7, obs.total)
        assertEquals(listOf(2, 5), obs.hands.map { it.count }, "mirrored preview: larger raw x is on the player's left")
        assertEquals(1, models.palmCalls)
        assertEquals(2, models.landmarkRois.size, "one interpreter, two sequential landmark runs")
        assertTrue(tracker.lastInferenceMs >= models.palmInferenceMs + 2 * 90f - 0.01f)
    }

    @Test
    fun everyUpdateRunsAFreshPalmDetection() {
        models.show(hand(3, 150f), hand(1, 480f))
        repeat(4) { update() }
        assertEquals(4, models.palmCalls, "no region following between updates")
        assertEquals(8, models.landmarkRois.size)
        assertTrue(tracker.lastUpdateSearched)
    }

    @Test
    fun eitherHandMayShowAnyNumberAndTotalsCoverZeroToTen() {
        for (a in 0..5) {
            for (b in 0..5) {
                models.show(hand(a, 150f), hand(b, 480f))
                val obs = update()
                assertEquals(a + b, obs.total, "$a + $b")
            }
        }
    }

    @Test
    fun twoFistsAreAConfidentZero() {
        models.show(hand(0, 150f), hand(0, 480f))
        val obs = update()
        assertNull(obs.rejection)
        assertEquals(0, obs.total)
    }

    @Test
    fun missingSecondHandIsNotScored() {
        models.show(hand(5, 150f))
        val obs = update()
        assertEquals(FingerRejection.OneHand, obs.rejection)
        assertFalse(obs.accepted)
        assertNull(obs.total)
        assertEquals(1, obs.hands.size)
    }

    @Test
    fun subThresholdPalmsAreReportedButNeverUsed() {
        models.show(SceneHand(SyntheticHands.points(SyntheticHands.showing(5), 150f, 400f), palmScore = 0.3f), hand(2, 480f))
        val obs = update()
        assertEquals(1, obs.rawPalms)
        assertEquals(0.3f, obs.bestBelowThreshold, 0.001f)
        assertEquals(1, models.landmarkRois.size, "a palm below 0.35 never reaches the landmark model")
        assertEquals(FingerRejection.OneHand, obs.rejection)
    }

    @Test
    fun aMaintainedRegionKeepsAHandThePalmDetectorMissed() {
        val a = hand(5, 150f)
        models.show(a, hand(2, 480f))
        assertEquals(7, update().total)
        val b3 = hand(3, 480f)
        models.show(a, b3)
        models.palms = listOf(HandShapes.palm(0.9f, 150f, 400f))
        val obs = update()
        assertNull(obs.rejection, "the second hand survives one missed palm detection")
        assertEquals(8, obs.total, "the region reads the new finger count, not the old one")
        assertTrue(obs.candidates.any { it.fromRegion && it.verdict == CandidateVerdict.Hand })
        assertEquals(0, tracker.lossCount)
    }

    @Test
    fun aMaintainedRegionDoesNotFabricateAHandThatLeft() {
        models.show(hand(5, 150f), hand(2, 480f))
        update()
        models.show(hand(5, 150f))
        val obs = update()
        assertEquals(FingerRejection.OneHand, obs.rejection)
        assertEquals(1, obs.hands.size)
        assertTrue(obs.candidates.any { it.fromRegion && it.verdict == CandidateVerdict.LowPresence })
        models.show()
        assertEquals(FingerRejection.NoHands, update().rejection, "a lowered hand is released, not reported as low presence")
    }

    @Test
    fun noPalmsMeansNoHands() {
        models.show()
        assertEquals(FingerRejection.NoHands, update().rejection)
    }

    @Test
    fun lowPresenceHandIsRejectedNotCounted() {
        models.show(hand(5, 150f), hand(2, 480f, presence = 0.3f))
        val obs = update()
        assertEquals(FingerRejection.OneHand, obs.rejection)
        assertEquals(1, obs.rejectedCandidates)
        assertNull(obs.total)
    }

    @Test
    fun duplicatePalmDetectionsAreMergedBeforeLandmarks() {
        models.show(hand(5, 150f), hand(5, 165f))
        val obs = update()
        assertEquals(1, models.landmarkRois.size)
        assertEquals(FingerRejection.OneHand, obs.rejection, "one physical hand is never counted twice")
    }

    @Test
    fun overlappingLandmarksFromTwoPalmsCountAsOneHand() {
        val only = hand(3, 150f)
        models.palms = listOf(HandShapes.palm(0.9f, 150f, 400f), HandShapes.palm(0.9f, 480f, 400f))
        models.responder = { SyntheticHands.landmarks(only.points) }
        val obs = update()
        assertEquals(FingerRejection.Duplicate, obs.rejection)
        assertEquals(1, obs.hands.size, "the same physical hand is kept once, never twice")
        assertEquals(listOf(CandidateVerdict.Hand, CandidateVerdict.SameHand), obs.candidates.map { it.verdict })
        assertNull(obs.total)
    }

    @Test
    fun fingertipsJustBeyondTheFrameEdgeStillCount() {
        models.show(SceneHand(SyntheticHands.points(SyntheticHands.showing(5), 150f, 110f)), hand(2, 480f))
        val obs = update()
        assertNull(obs.rejection, "fingertips 12 px above the top edge, palm fully inside")
        assertEquals(7, obs.total)
        assertTrue(obs.candidates.any { it.strictEdgeWouldReject }, "the old zero-outside rule would have rejected this hand")
    }

    @Test
    fun handFarOutOfFrameIsStillIncomplete() {
        models.show(SceneHand(SyntheticHands.points(SyntheticHands.showing(5), 150f, 60f)), hand(2, 480f))
        assertEquals(FingerRejection.Incomplete, update().rejection)
    }

    @Test
    fun aFalsePalmDoesNotCrowdOutTheSecondHand() {
        val a = hand(5, 150f)
        val b = hand(2, 480f)
        models.palms = listOf(HandShapes.palm(0.95f, 320f, 120f), HandShapes.palm(0.9f, 150f, 400f), HandShapes.palm(0.85f, 480f, 400f))
        models.responder = { roi ->
            when {
                kotlin.math.hypot(roi.cx - 320f, roi.cy - 120f) < 120f -> SyntheticHands.landmarks(a.points, presence = 0.1f)
                roi.cx < 320f -> SyntheticHands.landmarks(a.points)
                else -> SyntheticHands.landmarks(b.points)
            }
        }
        val obs = update()
        assertNull(obs.rejection)
        assertEquals(7, obs.total)
        assertEquals(3, models.landmarkRois.size)
        assertEquals(listOf(CandidateVerdict.LowPresence, CandidateVerdict.Hand, CandidateVerdict.Hand), obs.candidates.map { it.verdict })
    }

    @Test
    fun landmarkRunsAreBoundedPerUpdate() {
        models.palms = listOf(150f, 300f, 450f, 600f).map { HandShapes.palm(0.9f, it, 400f) }
        models.responder = { SyntheticHands.landmarks(hand(1, it.cx).points, presence = 0.1f) }
        val obs = update()
        assertEquals(3, models.landmarkRois.size)
        assertEquals(CandidateVerdict.NotRun, obs.candidates.last().verdict)
        assertEquals(4, obs.rawPalms)
    }

    @Test
    fun diagnosticsLineNamesEveryStage() {
        val lines = ArrayList<String>()
        val t = FingerTracker(models, { }, events = { lines += it })
        models.show(hand(5, 150f), hand(2, 480f, presence = 0.3f))
        t.process(frame, 640, 480, 1L)
        val line = lines.single()
        assertTrue(line.contains("palms 2"), line)
        assertTrue(line.contains("result OneHand"), line)
        assertTrue(line.contains("EEEEE=5 Hand"), line)
        assertTrue(line.contains("pres 0.3") && line.contains("LowPresence"), line)
    }

    @Test
    fun handPartlyOutOfFrameIsIncomplete() {
        models.show(hand(5, 30f), hand(2, 480f))
        val obs = update()
        assertEquals(FingerRejection.Incomplete, obs.rejection)
        assertNull(obs.total)
    }

    @Test
    fun tinyHandIsRejectedAsTooSmall() {
        models.show(hand(5, 150f, scale = 20f), hand(2, 480f))
        assertEquals(FingerRejection.TooSmall, update().rejection)
    }

    @Test
    fun uncertainHandBlocksTheTotalEvenWithHighPresence() {
        val poses = SyntheticHands.showing(4)
        poses[3] = Pose.Partial
        models.show(SceneHand(SyntheticHands.points(poses, 150f, 400f), presence = 1f), hand(2, 480f))
        val obs = update()
        assertEquals(FingerRejection.Uncertain, obs.rejection)
        assertEquals(2, obs.hands.size)
        assertNull(obs.total)
    }

    @Test
    fun identitiesPersistAcrossSmallMovesAndChangeForANewHand() {
        models.show(hand(1, 150f), hand(2, 480f))
        val first = update().hands.associate { it.wristX to it.id }
        models.show(hand(1, 170f), hand(2, 500f))
        val second = update().hands.associate { it.wristX to it.id }
        assertEquals(first[150f], second[170f])
        assertEquals(first[480f], second[500f])
        assertNotEquals(second[170f], second[500f])
        models.show(hand(1, 170f), hand(2, 330f, presence = 0.9f))
        val third = update()
        assertEquals(second[170f], third.hands.first { it.wristX == 170f }.id)
        assertTrue(third.hands.first { it.wristX == 330f }.id !in second.values, "a hand far from every previous hand gets a new identity")
        assertEquals(1, tracker.lossCount)
    }

    @Test
    fun handLossIsCountedWithItsReason() {
        models.show(hand(1, 150f), hand(2, 480f))
        update()
        models.show(hand(1, 150f))
        update()
        assertEquals(1, tracker.lossCount)
        assertEquals(1, tracker.losses(LossReason.Presence))
        models.show()
        update()
        models.show(hand(1, 150f), hand(2, 480f))
        update()
        assertEquals(1, tracker.reacquisitions)
    }

    @Test
    fun backendFailuresArePublishedAndCounted() {
        models.palmStatus = -3
        val obs = update()
        assertEquals(FingerRejection.BackendError, obs.rejection)
        assertEquals(1, tracker.consecutiveBackendErrors)
        models.palmStatus = null
        models.palms = listOf(HandShapes.palm(0.9f, 150f, 400f))
        models.responder = { null }
        assertEquals(FingerRejection.BackendError, update().rejection)
        assertEquals(2, tracker.consecutiveBackendErrors)
        assertEquals(-3, tracker.lastBackendStatus)
        models.show(hand(1, 150f), hand(2, 480f))
        update()
        assertEquals(0, tracker.consecutiveBackendErrors)
        assertEquals(2, tracker.backendErrors)
    }
}
