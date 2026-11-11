// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import com.fitbaus.arcade.Nv21Frames.Blob
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.math.abs

class ClassicalHandTrackerTest {
    private val w = 320
    private val h = 240
    private val fullFrame = TrackerConfig(region = CameraRegion.FULL)

    private fun ClassicalHandTracker.feed(frame: ByteArray, vararg blobs: Blob): TrackerPoint? =
        process(Nv21Frames.paint(frame, w, h, *blobs), w, h)

    private fun acquireAndStop(tracker: ClassicalHandTracker, frame: ByteArray, startX: Int, y: Int, vararg extra: Blob): Int {
        var x = startX
        for (i in 0 until 8) {
            x = startX + 8 * i
            tracker.feed(frame, Blob(x, y, 48), *extra)
        }
        assertTrue(tracker.isTracking, "hand acquired while moving")
        return x
    }

    @Test
    fun emptySceneIsLost() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        repeat(30) { assertNull(tracker.feed(frame)) }
        assertEquals(80, tracker.gridColumns)
        assertEquals(60, tracker.gridRows)
        assertFalse(tracker.isTracking)
    }

    @Test
    fun staticSkinBlobPresentFromStartIsIgnored() {
        val tracker = ClassicalHandTracker(fullFrame)
        val frame = Nv21Frames.allocate(w, h)
        repeat(60) { assertNull(tracker.feed(frame, Blob(140, 40, 60))) }
    }

    @Test
    fun movingNonSkinObjectIsIgnored() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        for (i in 0 until 20) assertNull(tracker.feed(frame, Blob(40 + 8 * i, 100, 48, skin = false)))
    }

    @Test
    fun translatingSkinBlobIsTracked() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        var previousX = -1f
        var tracked = 0
        for (i in 0 until 20) {
            val x = 40 + 8 * i
            val point = tracker.feed(frame, Blob(x, 96, 48))
            if (i == 0) {
                assertNull(point, "first frame has no motion reference")
                continue
            }
            if (point == null) continue
            tracked += 1
            assertTrue(point.x >= previousX, "x follows the hand: ${point.x} after $previousX")
            previousX = point.x
            if (i >= 8) {
                assertEquals((x + 24f) / w, point.x, 0.05f, "frame $i")
                assertEquals((96f + 24f) / h, point.y, 0.05f, "frame $i")
                assertTrue(point.confidence > 0.5f)
            }
        }
        assertTrue(tracked >= 18, "tracked $tracked of 19 moving frames")
    }

    @Test
    fun stationaryHandStaysTrackedWhileVisible() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        val x = acquireAndStop(tracker, frame, 40, 96)
        val expected = (x + 24f) / w
        for (i in 0 until 150) {
            val point = tracker.feed(frame, Blob(x, 96, 48))
            requireNotNull(point) { "stationary frame $i lost" }
            if (i >= 6) assertEquals(expected, point.x, 0.01f, "stationary frame $i")
            assertTrue(point.confidence > 0.5f)
        }
        assertTrue(tracker.isTracking)
    }

    @Test
    fun wigglingHandGivesStablePoint() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        val xs = ArrayList<Float>()
        for (i in 0 until 40) {
            val luma = if (i % 2 == 0) 140 else 175
            val point = tracker.feed(frame, Blob(200, 120, 48, luma = luma))
            if (i >= 2) xs += requireNotNull(point).x
        }
        for (x in xs) assertEquals((200f + 24f) / w, x, 0.02f)
        val jitter = xs.zipWithNext { a, b -> abs(a - b) }.maxOrNull() ?: 0f
        assertTrue(jitter < 0.005f, "jitter $jitter")
    }

    @Test
    fun disappearingStationaryHandIsLostWithinGraceFrames() {
        val config = TrackerConfig(graceFrames = 4)
        val tracker = ClassicalHandTracker(config)
        val frame = Nv21Frames.allocate(w, h)
        val x = acquireAndStop(tracker, frame, 40, 96)
        repeat(30) { requireNotNull(tracker.feed(frame, Blob(x, 96, 48))) }
        for (i in 0..config.graceFrames) {
            assertNull(tracker.feed(frame), "no coordinate once the hand is gone (frame $i)")
        }
        assertFalse(tracker.isTracking, "track dropped after ${config.graceFrames + 1} empty frames")
        repeat(30) { assertNull(tracker.feed(frame)) }
    }

    @Test
    fun briefOcclusionWithinGraceKeepsTrack() {
        val tracker = ClassicalHandTracker(TrackerConfig(graceFrames = 4))
        val frame = Nv21Frames.allocate(w, h)
        val x = acquireAndStop(tracker, frame, 40, 96)
        repeat(20) { tracker.feed(frame, Blob(x, 96, 48)) }
        repeat(2) { assertNull(tracker.feed(frame)) }
        assertTrue(tracker.isTracking)
        requireNotNull(tracker.feed(frame, Blob(x, 96, 48)))
    }

    @Test
    fun disappearanceReachesLostThroughInputWithinHold() {
        val input = HandPositionInput(holdNanos = 500_000_000L)
        var now = 0L
        val sink = TrackingFrameSink(ClassicalHandTracker(), input, input.cameraGeneration(), clock = { now })
        sink.mirror = false
        val frame = Nv21Frames.allocate(w, h)
        val frameNanos = 66_000_000L
        for (i in 0 until 8) {
            now += frameNanos
            sink.onFrame(Nv21Frames.paint(frame, w, h, Blob(40 + 8 * i, 96, 48)), w, h)
        }
        repeat(60) {
            now += frameNanos
            sink.onFrame(Nv21Frames.paint(frame, w, h, Blob(96, 96, 48)), w, h)
        }
        assertEquals(HandSource.Camera, input.latest(now).source, "stationary hand still tracked after 4 s")
        val goneAt = now
        var lostAt = -1L
        for (i in 0 until 30) {
            now += frameNanos
            sink.onFrame(Nv21Frames.paint(frame, w, h), w, h)
            if (input.latest(now).source == HandSource.Lost) {
                lostAt = now
                break
            }
        }
        assertTrue(lostAt > 0, "never reached LOST")
        assertTrue(lostAt - goneAt <= 500_000_000L + frameNanos, "LOST after ${(lostAt - goneAt) / 1_000_000} ms")
    }

    @Test
    fun movingFaceAboveDefaultRegionIsIgnored() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        for (i in 0 until 40) {
            val bob = if (i % 4 < 2) 0 else 10
            assertNull(tracker.feed(frame, Blob(130 + (i % 3) * 6, 10 + bob, 60)), "face frame $i")
        }
    }

    @Test
    fun handTrackedBelowMovingFace() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        var last: TrackerPoint? = null
        for (i in 0 until 40) {
            val face = Blob(130 + (i % 3) * 6, 8 + (i % 2) * 8, 60)
            val handX = if (i < 10) 20 + 6 * i else 74
            last = tracker.feed(frame, face, Blob(handX, 150, 44))
        }
        val point = requireNotNull(last)
        assertEquals((74f + 22f) / w, point.x, 0.03f)
        assertTrue(point.y > 0.6f, "point on the hand, not the face: $point")
    }

    @Test
    fun movingFaceInsideRegionDoesNotStealStationaryHand() {
        val tracker = ClassicalHandTracker(fullFrame)
        val frame = Nv21Frames.allocate(w, h)
        val face = { i: Int -> Blob(220, 20 + (i % 4) * 8, 64) }
        var x = 8
        for (i in 0 until 8) {
            x = 8 + 6 * i
            tracker.feed(frame, face(0), Blob(x, 150, 48))
        }
        assertTrue(tracker.isTracking)
        for (i in 0 until 60) {
            val point = requireNotNull(tracker.feed(frame, face(i), Blob(x, 150, 48))) { "frame $i" }
            assertEquals((x + 24f) / w, point.x, 0.03f, "frame $i stays on the hand")
        }
    }

    @Test
    fun movingBackgroundDoesNotBreakStationaryTrack() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        val x = acquireAndStop(tracker, frame, 40, 120)
        for (i in 0 until 60) {
            val passer = Blob(160 + (i % 10) * 8, 100 + (i % 5) * 6, 70, luma = 200, skin = false)
            val point = requireNotNull(tracker.feed(frame, Blob(x, 120, 48), passer)) { "frame $i" }
            assertEquals((x + 24f) / w, point.x, 0.02f)
        }
    }

    @Test
    fun regionRestrictsDetectionAndMapsToPlayground() {
        val region = CameraRegion(0.5f, 0f, 1f, 1f)
        val tracker = ClassicalHandTracker(TrackerConfig(region = region))
        assertEquals(region, tracker.region)
        val frame = Nv21Frames.allocate(w, h)
        for (i in 0 until 12) assertNull(tracker.feed(frame, Blob(10 + 8 * i, 96, 48)), "left-half hand ignored")
        assertEquals(40, tracker.regionColumns)
        assertEquals(60, tracker.regionRows)

        val input = HandPositionInput()
        var now = 0L
        val sink = TrackingFrameSink(ClassicalHandTracker(TrackerConfig(region = region)), input, input.cameraGeneration(), clock = { now })
        sink.mirror = false
        var hx = 0
        for (i in 0 until 12) {
            hx = 176 + 8 * i
            now += 33_000_000L
            sink.onFrame(Nv21Frames.paint(frame, w, h, Blob(hx, 96, 48)), w, h)
        }
        val position = input.latest(now)
        assertEquals(HandSource.Camera, position.source)
        val cameraX = (hx + 24f) / w
        assertEquals((cameraX - 0.5f) / 0.5f, position.x, 0.07f)
    }

    @Test
    fun defaultRegionExcludesTopOfFrame() {
        val tracker = ClassicalHandTracker()
        tracker.process(Nv21Frames.allocate(w, h), w, h)
        assertEquals(TrackerConfig.DEFAULT_REGION, tracker.region)
        assertEquals(80, tracker.regionColumns)
        assertEquals(39, tracker.regionRows)
    }

    @Test
    fun steadyStateReusesBuffers() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        for (i in 0 until 200) tracker.feed(frame, Blob(40 + (i % 30) * 6, 96, 48))
        assertEquals(1, tracker.bufferAllocations, "only the warm-start allocation")
        val bigger = Nv21Frames.allocate(640, 480)
        tracker.process(Nv21Frames.paint(bigger, 640, 480), 640, 480)
        assertEquals(2, tracker.bufferAllocations)
        assertEquals(80, tracker.gridColumns)
        repeat(20) { tracker.process(Nv21Frames.paint(bigger, 640, 480), 640, 480) }
        assertEquals(2, tracker.bufferAllocations)
    }

    @Test
    fun resetForgetsMotionReferenceAndTrack() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        acquireAndStop(tracker, frame, 40, 96)
        tracker.reset()
        assertFalse(tracker.isTracking)
        assertNull(tracker.feed(frame, Blob(200, 96, 48)))
    }

    @Test
    fun rejectsInvalidInput() {
        val tracker = ClassicalHandTracker()
        assertThrows<IllegalArgumentException> { tracker.process(ByteArray(10), w, h) }
        assertThrows<IllegalArgumentException> { tracker.process(ByteArray(10), 1, 1) }
        assertThrows<IllegalArgumentException> { TrackerConfig(keepCells = 20, acquireCells = 10) }
        assertThrows<IllegalArgumentException> { CameraRegion(0.5f, 0f, 1.2f, 1f) }
    }

    @Test
    fun sinkMirrorsPublishesAndSkipsFrames() {
        val input = HandPositionInput()
        var now = 1_000_000_000L
        val sink = TrackingFrameSink(ClassicalHandTracker(), input, input.cameraGeneration(), processEvery = 2, clock = { now })
        sink.mirror = true
        val frame = Nv21Frames.allocate(w, h)
        var processed = 0
        for (i in 0 until 24) {
            now += 33_000_000L
            if (sink.onFrame(Nv21Frames.paint(frame, w, h, Blob(40 + 4 * i, 96, 48)), w, h)) processed += 1
        }
        assertEquals(12, processed)
        assertEquals(12L, sink.processedFrames)
        assertEquals(1, sink.bufferAllocations)
        val position = input.latest(now)
        assertEquals(HandSource.Camera, position.source)
        val rawX = (40f + 4 * 23 + 24f) / w
        assertEquals(1f - rawX, position.x, 0.06f, "front camera x is mirrored")
    }

    @Test
    fun sinkFromStoppedSessionCannotPublish() {
        val input = HandPositionInput()
        val sink = TrackingFrameSink(ClassicalHandTracker(), input, input.cameraGeneration())
        input.clearCamera()
        val frame = Nv21Frames.allocate(w, h)
        for (i in 0 until 10) sink.onFrame(Nv21Frames.paint(frame, w, h, Blob(40 + 8 * i, 96, 48)), w, h)
        assertEquals(HandSource.Lost, input.latest(System.nanoTime()).source)
    }
}
