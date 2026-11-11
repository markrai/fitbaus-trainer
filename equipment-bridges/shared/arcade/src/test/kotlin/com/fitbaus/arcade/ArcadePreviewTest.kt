// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import com.fitbaus.arcade.Nv21Frames.Blob
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ArcadePreviewTest {
    private val w = 320
    private val h = 240

    private fun luma(pixel: Int): Int = pixel and 0xFF

    private fun isTinted(pixel: Int): Boolean = ((pixel shr 8) and 0xFF) > ((pixel shr 16) and 0xFF) + 40

    @Test
    fun previewIsMirroredGrayscaleOfTheFullFrame() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.paint(Nv21Frames.allocate(w, h), w, h, Blob(0, 0, 40, luma = 200, skin = false))
        tracker.process(frame, w, h)
        val dest = IntArray(tracker.gridColumns * tracker.gridRows)
        tracker.renderPreview(frame, w, mirror = true, dest = dest)
        val cols = tracker.gridColumns
        assertEquals(200, luma(dest[cols - 1]), "top-left of the camera frame appears top-right when mirrored")
        assertEquals(Nv21Frames.BACKGROUND_LUMA, luma(dest[0]))
        assertEquals(-0x1000000, dest[0] and -0x1000000, "opaque")
        tracker.renderPreview(frame, w, mirror = false, dest = dest)
        assertEquals(200, luma(dest[0]))
        assertFalse(dest.any { isTinted(it) }, "nothing tracked yet")
    }

    @Test
    fun trackedHandCellsAreTintedInsideTheRegionOnly() {
        val tracker = ClassicalHandTracker()
        val frame = Nv21Frames.allocate(w, h)
        for (i in 0 until 8) tracker.process(Nv21Frames.paint(frame, w, h, Blob(40 + 8 * i, 120, 48)), w, h)
        assertTrue(tracker.isTracking)
        val cols = tracker.gridColumns
        val dest = IntArray(cols * tracker.gridRows)
        tracker.renderPreview(frame, w, mirror = false, dest = dest)
        val handCell = (120 + 24) / 4 * cols + (96 + 24) / 4
        assertTrue(isTinted(dest[handCell]), "hand centre is tinted")
        val topCells = (0.35f * tracker.gridRows).toInt() * cols
        assertFalse((0 until topCells).any { isTinted(dest[it]) }, "no tint outside the detection region")
        tracker.renderPreview(frame, w, mirror = true, dest = dest)
        val mirroredCell = (120 + 24) / 4 * cols + (cols - 1 - (96 + 24) / 4)
        assertTrue(isTinted(dest[mirroredCell]))
    }

    @Test
    fun sinkPublishesEveryNthFrameWithoutReallocating() {
        val input = HandPositionInput()
        val preview = ArcadePreview()
        val sink = TrackingFrameSink(ClassicalHandTracker(), input, input.cameraGeneration(), preview = preview, previewEvery = 5)
        sink.mirror = true
        val snapshot = PreviewSnapshot()
        val frame = Nv21Frames.allocate(w, h)
        var updates = 0
        for (i in 0 until 50) {
            sink.onFrame(Nv21Frames.paint(frame, w, h, Blob(40 + 4 * (i % 20), 120, 48)), w, h)
            if (preview.copyTo(snapshot)) updates += 1
        }
        assertEquals(10, updates)
        assertFalse(preview.copyTo(snapshot), "no new version without a new publish")
        assertEquals(80, snapshot.width)
        assertEquals(60, snapshot.height)
        assertEquals(1, sink.previewBufferAllocations)
        assertEquals(1, preview.bufferAllocations)
        assertEquals(0f, snapshot.regionLeft, 1e-6f)
        assertEquals(0.35f, snapshot.regionTop, 1e-6f)
        assertEquals(1f, snapshot.regionRight, 1e-6f)
    }

    @Test
    fun publishedPointAndRegionAreMirrored() {
        val input = HandPositionInput()
        val preview = ArcadePreview()
        val region = CameraRegion(0.5f, 0.2f, 1f, 1f)
        val sink = TrackingFrameSink(
            ClassicalHandTracker(TrackerConfig(region = region)),
            input,
            input.cameraGeneration(),
            preview = preview,
            previewEvery = 1,
        )
        sink.mirror = true
        val frame = Nv21Frames.allocate(w, h)
        for (i in 0 until 10) sink.onFrame(Nv21Frames.paint(frame, w, h, Blob(200 + 6 * i, 120, 48)), w, h)
        val snapshot = PreviewSnapshot()
        assertTrue(preview.copyTo(snapshot))
        assertEquals(0f, snapshot.regionLeft, 1e-6f)
        assertEquals(0.5f, snapshot.regionRight, 1e-6f)
        assertEquals(0.2f, snapshot.regionTop, 1e-6f)
        assertFalse(snapshot.pointX.isNaN())
        assertEquals(1f - (254f + 24f) / w, snapshot.pointX, 0.05f)
        assertTrue(snapshot.pointX < 0.5f, "a hand on camera-right shows on the preview's left")
    }

    @Test
    fun noPointWhenNothingTracked() {
        val input = HandPositionInput()
        val preview = ArcadePreview()
        val sink = TrackingFrameSink(ClassicalHandTracker(), input, input.cameraGeneration(), preview = preview, previewEvery = 1)
        val frame = Nv21Frames.allocate(w, h)
        repeat(3) { sink.onFrame(Nv21Frames.paint(frame, w, h), w, h) }
        val snapshot = PreviewSnapshot()
        assertTrue(preview.copyTo(snapshot))
        assertTrue(snapshot.pointX.isNaN())
    }

    @Test
    fun clearHidesPreviewAndDropsLateFramesFromStoppedSession() {
        val input = HandPositionInput()
        val preview = ArcadePreview()
        val oldSink = TrackingFrameSink(ClassicalHandTracker(), input, input.cameraGeneration(), preview = preview, previewEvery = 1)
        val frame = Nv21Frames.allocate(w, h)
        oldSink.onFrame(Nv21Frames.paint(frame, w, h), w, h)
        val snapshot = PreviewSnapshot()
        assertTrue(preview.copyTo(snapshot))
        assertEquals(80, snapshot.width)
        preview.clear()
        assertTrue(preview.copyTo(snapshot))
        assertEquals(0, snapshot.width)
        oldSink.onFrame(Nv21Frames.paint(frame, w, h), w, h)
        assertFalse(preview.copyTo(snapshot), "late frame from the stopped session is ignored")
        val newSink = TrackingFrameSink(ClassicalHandTracker(), input, input.cameraGeneration(), preview = preview, previewEvery = 1)
        newSink.onFrame(Nv21Frames.paint(frame, w, h), w, h)
        assertTrue(preview.copyTo(snapshot))
        assertEquals(80, snapshot.width)
    }

    @Test
    fun sessionClearsPreviewOnStopAndKeepsOneInstance() {
        val input = HandPositionInput()
        val sinks = ArrayList<FrameConsumer>()
        val session = ArcadeCameraSession(FakePermission(granted = true), input) { sink ->
            sinks += sink
            FakeFrameSource(sink)
        }
        val preview = session.preview
        session.start()
        val frame = Nv21Frames.allocate(w, h)
        repeat(6) { sinks[0].onFrame(Nv21Frames.paint(frame, w, h), w, h) }
        val snapshot = PreviewSnapshot()
        assertTrue(preview.copyTo(snapshot))
        assertTrue(snapshot.width > 0)
        session.stop(ArcadeStopReason.ExitArcade)
        assertTrue(preview.copyTo(snapshot))
        assertEquals(0, snapshot.width)
        session.start()
        assertTrue(session.preview === preview)
        repeat(6) { sinks[1].onFrame(Nv21Frames.paint(frame, w, h), w, h) }
        assertTrue(preview.copyTo(snapshot))
        assertTrue(snapshot.width > 0)
    }
}
