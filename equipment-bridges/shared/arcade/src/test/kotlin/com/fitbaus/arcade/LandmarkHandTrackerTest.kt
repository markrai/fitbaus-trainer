// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.PI
import kotlin.math.abs

class LandmarkHandTrackerTest {
    private val w = 640
    private val h = 480
    private val frame = ByteArray(w * h * 3 / 2)
    private val ms = 1_000_000L

    private fun tracker(models: FakeHandModels, config: LandmarkConfig = LandmarkConfig(smoothingTauNanos = 0L)) =
        LandmarkHandTracker(models, config)

    private fun handAt(wristX: Float, wristY: Float, presence: Float = 0.99f, handedness: Float = 0.95f) =
        HandShapes.landmarks(presence, handedness, wristX, wristY)

    @Test
    fun acquiresWithPalmOnceThenTracksWithLandmarksOnly() {
        val models = FakeHandModels()
        models.palms = listOf(HandShapes.palm(0.9f, 320f, 360f))
        models.responder = { handAt(320f, 360f) }
        val t = tracker(models)
        val first = requireNotNull(t.process(frame, w, h, 0L))
        assertTrue(first.acquired)
        assertEquals((320f - 24f) / w, first.x, 1e-4f, "index fingertip x")
        assertEquals((360f - 115f) / h, first.y, 1e-4f, "index fingertip y")
        repeat(4) { i -> assertFalse(requireNotNull(t.process(frame, w, h, (i + 1) * 200 * ms)).acquired) }
        assertEquals(1, models.palmCalls, "palm detection only for acquisition")
        assertEquals(5, models.landmarkRois.size)
        assertTrue(t.isTracking)
        assertEquals(0, t.lossCount)
    }

    @Test
    fun regionFollowsTheMovingHand() {
        val models = FakeHandModels()
        models.palms = listOf(HandShapes.palm(0.9f, 200f, 360f))
        var wrist = 200f
        models.responder = { handAt(wrist, 360f) }
        val t = tracker(models)
        for (i in 0 until 6) {
            requireNotNull(t.process(frame, w, h, i * 200 * ms)) { "update $i" }
            wrist += 40f
        }
        val last = models.landmarkRois.last()
        assertEquals(360f - 9.5f, last.cx, 2f, "region recentred on the hand seen in the previous update")
        assertEquals(0f, last.rotation, 0.05f, "upright hand keeps an upright region")
        assertEquals(1, models.palmCalls)
    }

    @Test
    fun presenceDropLosesTrackAndNextUpdateSearchesAgain() {
        val models = FakeHandModels()
        models.palms = listOf(HandShapes.palm(0.9f, 320f, 360f))
        var presence = 0.99f
        models.responder = { handAt(320f, 360f, presence) }
        val t = tracker(models)
        requireNotNull(t.process(frame, w, h, 0L))
        presence = 0.1f
        assertNull(t.process(frame, w, h, 200 * ms))
        assertFalse(t.isTracking)
        assertEquals(1, t.lossCount)
        presence = 0.99f
        assertNotNull(t.process(frame, w, h, 400 * ms))
        assertEquals(2, models.palmCalls)
        assertEquals(1, t.reacquisitions)
    }

    @Test
    fun realDisappearanceReturnsNothingWithoutLandmarkWork() {
        val models = FakeHandModels()
        models.palms = listOf(HandShapes.palm(0.9f, 320f, 360f))
        var visible = true
        models.responder = { if (visible) handAt(320f, 360f) else handAt(320f, 360f, presence = 0.02f) }
        val t = tracker(models)
        requireNotNull(t.process(frame, w, h, 0L))
        visible = false
        models.palms = emptyList()
        assertNull(t.process(frame, w, h, 200 * ms))
        val landmarkCalls = models.landmarkRois.size
        repeat(5) { i -> assertNull(t.process(frame, w, h, (i + 2) * 200 * ms)) }
        assertEquals(landmarkCalls, models.landmarkRois.size, "no landmark inference while nothing is detected")
        assertEquals(1, t.lossCount)
        assertEquals(6, models.palmCalls)
    }

    @Test
    fun continuityBreakDropsTheTrack() {
        val models = FakeHandModels()
        models.palms = listOf(HandShapes.palm(0.9f, 150f, 360f))
        var wrist = 150f
        models.responder = { handAt(wrist, 360f) }
        val t = tracker(models)
        requireNotNull(t.process(frame, w, h, 0L))
        wrist = 150f + 0.5f * w
        assertNull(t.process(frame, w, h, 200 * ms), "a 50% jump between updates is not the same hand")
        assertEquals(1, t.lossCount)
    }

    @Test
    fun handednessFlipNeedsConsecutiveConfidentUpdates() {
        val models = FakeHandModels()
        models.palms = listOf(HandShapes.palm(0.9f, 320f, 360f))
        var handedness = 0.95f
        models.responder = { handAt(320f, 360f, handedness = handedness) }
        val t = tracker(models)
        requireNotNull(t.process(frame, w, h, 0L))
        assertEquals(true, t.isRightHand)
        handedness = 0.05f
        assertNotNull(t.process(frame, w, h, 200 * ms), "one opposite label is tolerated")
        handedness = 0.95f
        assertNotNull(t.process(frame, w, h, 400 * ms))
        handedness = 0.05f
        assertNotNull(t.process(frame, w, h, 600 * ms))
        assertNull(t.process(frame, w, h, 800 * ms), "two consecutive confident opposite labels drop the track")
    }

    @Test
    fun reacquisitionPrefersTheHandNearestItsLastPosition() {
        val models = FakeHandModels()
        models.palms = listOf(HandShapes.palm(0.9f, 200f, 360f))
        var wrist = 200f
        var presence = 0.99f
        models.responder = { roi -> handAt(if (roi.cx > 320f) 480f else wrist, 360f, presence) }
        val t = tracker(models)
        requireNotNull(t.process(frame, w, h, 0L))
        presence = 0.1f
        assertNull(t.process(frame, w, h, 200 * ms))
        presence = 0.99f
        wrist = 210f
        models.palms = listOf(HandShapes.palm(0.97f, 480f, 360f), HandShapes.palm(0.8f, 210f, 360f))
        val before = models.landmarkRois.size
        requireNotNull(t.process(frame, w, h, 400 * ms))
        assertTrue(models.landmarkRois[before].cx < 320f, "the remembered hand is tried first despite a lower palm score")
        assertEquals(1, t.reacquisitions)
    }

    @Test
    fun identityMismatchTriesTheNextCandidate() {
        val models = FakeHandModels()
        models.palms = listOf(HandShapes.palm(0.9f, 200f, 360f))
        var presence = 0.99f
        models.responder = { roi ->
            val left = roi.cx < 250f || roi.cx > 500f
            handAt(roi.cx, 360f, presence, handedness = if (left) 0.05f else 0.95f)
        }
        val t = tracker(models)
        requireNotNull(t.process(frame, w, h, 0L))
        assertEquals(false, t.isRightHand)
        presence = 0.1f
        assertNull(t.process(frame, w, h, 200 * ms))
        presence = 0.99f
        models.palms = listOf(HandShapes.palm(0.95f, 300f, 360f), HandShapes.palm(0.9f, 560f, 360f))
        val before = models.landmarkRois.size
        requireNotNull(t.process(frame, w, h, 400 * ms))
        assertEquals(2, models.landmarkRois.size - before, "nearest candidate was the other hand, so the next one was tried")
        assertEquals(false, t.isRightHand, "kept the same (left) hand")
        assertTrue(models.landmarkRois.last().cx > 500f)
    }

    @Test
    fun expiredIdentityMemoryTakesTheStrongestPalm() {
        val models = FakeHandModels()
        models.palms = listOf(HandShapes.palm(0.9f, 200f, 360f))
        var presence = 0.99f
        models.responder = { roi -> handAt(roi.cx, 360f, presence) }
        val t = tracker(models, LandmarkConfig(smoothingTauNanos = 0L, identityMemoryNanos = 500 * ms))
        requireNotNull(t.process(frame, w, h, 0L))
        presence = 0.1f
        assertNull(t.process(frame, w, h, 200 * ms))
        presence = 0.99f
        models.palms = listOf(HandShapes.palm(0.97f, 480f, 360f), HandShapes.palm(0.8f, 210f, 360f))
        val before = models.landmarkRois.size
        requireNotNull(t.process(frame, w, h, 2_000 * ms))
        assertTrue(models.landmarkRois[before].cx > 320f)
    }

    @Test
    fun regionLeavingTheFrameIsTreatedAsLoss() {
        val models = FakeHandModels()
        models.palms = listOf(HandShapes.palm(0.9f, 320f, 360f))
        var wrist = 320f
        models.responder = { handAt(wrist, 360f) }
        val t = tracker(models, LandmarkConfig(smoothingTauNanos = 0L, maxJumpFraction = 2f))
        requireNotNull(t.process(frame, w, h, 0L))
        wrist = w + 400f
        assertNull(t.process(frame, w, h, 200 * ms))
        assertEquals(1, t.lossCount)
    }

    @Test
    fun timeBasedSmoothingAndDeadZone() {
        val s = TimeSmoother(tauNanos = 100 * ms, deadZone = 0.002f)
        s.update(0.2f, 0.5f, 0L)
        assertEquals(0.2f, s.x)
        s.update(0.8f, 0.5f, 100 * ms)
        assertEquals(0.2f + 0.6f * 0.6321f, s.x, 1e-3f, "one time constant reaches 63%")
        val held = s.x
        s.update(held + 0.001f, 0.5f, 300 * ms)
        assertEquals(held, s.x, "movement inside the dead zone is ignored")
        s.update(0.9f, 0.5f, 1_300 * ms)
        assertEquals(0.9f, s.x, 1e-3f, "long gaps converge fully")
        s.reset()
        s.update(0.1f, 0.1f, 1_400 * ms)
        assertEquals(0.1f, s.x)
    }

    @Test
    fun smoothingAt5HzStaysResponsive() {
        val s = TimeSmoother(tauNanos = 100 * ms, deadZone = 0f)
        s.update(0f, 0f, 0L)
        s.update(1f, 0f, 200 * ms)
        assertTrue(s.x > 0.85f, "at 5 Hz one update covers most of the step: ${s.x}")
    }

    @Test
    fun roiMath() {
        val hand = HandShapes.landmarks(1f, 1f, 320f, 400f)
        val roi = RoiMath.fromLandmarks(hand, 2)
        assertEquals(0f, roi.rotation, 1e-3f)
        assertTrue(roi.cy < 400f - 40f, "region shifted toward the fingers")
        assertEquals(2.0f * 91f, roi.size, 2f)
        assertEquals((PI / 2).toFloat(), RoiMath.rotationBetween(0f, 0f, 10f, 0f), 1e-4f, "fingers pointing right")
        assertEquals(0f, RoiMath.rotationBetween(0f, 0f, 0f, -10f), 1e-4f, "fingers pointing up")
        val wrapped = RoiMath.normalizeAngle((3 * PI).toFloat())
        assertTrue(abs(abs(wrapped) - PI.toFloat()) < 1e-4f)
        val palmRoi = RoiMath.fromPalm(HandShapes.palm(0.9f, 320f, 400f), 0)
        assertEquals(0f, palmRoi.rotation, 1e-3f)
        assertEquals(0.9f * 100f * 2.6f, palmRoi.size, 1e-2f)
        assertEquals(400f - 45f - 45f, palmRoi.cy, 1e-2f)
    }

    @Test
    fun landmarkRegionMatchesTheValidatedNativeHarness() {
        val raw = "368.2,291.4 362.5,249.5 346.7,215.8 328.0,187.8 314.3,164.2 292.2,236.5 273.1,234.2 302.3,239.6 312.9,239.5 " +
            "288.7,261.0 272.9,259.9 311.1,263.0 311.9,260.2 289.4,284.4 273.3,283.3 305.6,283.5 306.9,280.8 290.4,305.7 " +
            "274.0,304.7 296.4,300.7 302.4,298.3"
        val xy = FloatArray(HandModelLayout.LANDMARK_STRIDE)
        raw.split(" ").forEachIndexed { i, pair ->
            val (x, y) = pair.split(",").map { it.toFloat() }
            xy[2 + i * 2] = x
            xy[3 + i * 2] = y
        }
        val roi = RoiMath.fromLandmarks(xy, 2)
        assertEquals(313f, roi.cx, 1f)
        assertEquals(251f, roi.cy, 1f)
        assertEquals(257f, roi.size, 1f)
        assertEquals(-1.21f, roi.rotation, 0.01f)
    }
}
