// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FaceTrackerTest {
    private val w = 640
    private val h = 480
    private val ms = 1_000_000L
    private val frame = ByteArray(w * h * 3 / 2)

    private fun tracker(models: FakeHandModels, events: MutableList<String>? = null) =
        FaceTracker(models, FaceConfig(smoothingTauNanos = 0L), events?.let { list -> { msg: String -> list += msg } })

    @Test
    fun followsTheNoseAndDetectsEveryUpdate() {
        val models = FakeHandModels()
        models.faces = listOf(HandShapes.face(0.95f, 320f, 140f))
        val t = tracker(models)
        val first = requireNotNull(t.process(frame, w, h, 0L))
        assertTrue(first.acquired)
        assertEquals(0.5f, first.x, 1e-4f)
        assertEquals(140f / h, first.y, 1e-4f)
        models.faces = listOf(HandShapes.face(0.95f, 352f, 140f))
        val next = requireNotNull(t.process(frame, w, h, 100 * ms))
        assertFalse(next.acquired)
        assertEquals(352f / w, next.x, 1e-4f)
        assertEquals(2, models.faceCalls)
        assertEquals(0, models.palmCalls, "no hand models are used")
        assertEquals(55f, t.lastInferenceMs)
    }

    @Test
    fun startsOnTheLargestFaceThenStaysWithIt() {
        val models = FakeHandModels()
        models.faces = listOf(HandShapes.face(0.97f, 500f, 140f, size = 50f), HandShapes.face(0.9f, 250f, 160f, size = 110f))
        val t = tracker(models)
        assertEquals(250f / w, requireNotNull(t.process(frame, w, h, 0L)).x, 1e-4f, "the rider's (largest) face")
        models.faces = listOf(HandShapes.face(0.97f, 260f, 160f, size = 60f), HandShapes.face(0.9f, 450f, 160f, size = 140f))
        assertEquals(260f / w, requireNotNull(t.process(frame, w, h, 100 * ms)).x, 1e-4f, "continuity beats size once tracking")
    }

    @Test
    fun noFaceIsALossWithAReason() {
        val models = FakeHandModels()
        val events = ArrayList<String>()
        models.faces = listOf(HandShapes.face(0.95f, 320f, 140f))
        val t = tracker(models, events)
        requireNotNull(t.process(frame, w, h, 0L))
        models.faces = emptyList()
        assertNull(t.process(frame, w, h, 100 * ms))
        assertFalse(t.isTracking)
        assertEquals(1, t.losses(LossReason.Presence))
        assertNull(t.process(frame, w, h, 200 * ms))
        assertEquals(1, t.lossCount, "only the transition counts")
        models.faces = listOf(HandShapes.face(0.95f, 320f, 140f))
        assertTrue(requireNotNull(t.process(frame, w, h, 300 * ms)).acquired)
        assertEquals(1, t.reacquisitions)
        assertTrue(events.any { it == "lost face: Presence - no face detected" }, "$events")
        assertTrue(events.count { it.startsWith("acquired face") } == 2)
    }

    @Test
    fun aJumpToAnotherFaceIsNotTreatedAsTheSameRider() {
        val models = FakeHandModels()
        models.faces = listOf(HandShapes.face(0.95f, 100f, 140f))
        val t = tracker(models)
        requireNotNull(t.process(frame, w, h, 0L))
        models.faces = listOf(HandShapes.face(0.95f, 560f, 140f))
        assertNull(t.process(frame, w, h, 100 * ms))
        assertEquals(1, t.losses(LossReason.WristJump))
        assertTrue(requireNotNull(t.process(frame, w, h, 200 * ms)).acquired)
    }

    @Test
    fun backendErrorsAreCountedNotHidden() {
        val models = FakeHandModels()
        models.faceStatus = -3
        val t = tracker(models)
        repeat(3) { assertNull(t.process(frame, w, h, it * 100 * ms)) }
        assertEquals(3, t.backendErrors)
        assertEquals(3, t.consecutiveBackendErrors)
        assertEquals(-3, t.lastBackendStatus)
    }

    @Test
    fun faceSinkMapsTheCentreBandMirroredAndFailsVisiblyOnErrors() {
        val models = FakeHandModels()
        models.faces = listOf(HandShapes.face(0.95f, 0.35f * w, 140f))
        val input = HandPositionInput()
        val clock = FakeClock()
        val sink = LandmarkFrameSink(
            backendFactory = { models },
            input = input,
            generation = input.cameraGeneration(),
            settings = ArcadeTrackerSettings.FACE_DEFAULT,
            config = LandmarkConfig(idleSearchHz = 10f),
            controlRegion = ArcadeCameraSession.FACE_CONTROL_REGION,
            clock = { clock.nanos },
            startWorker = false,
            gate = NativeSessionGate(),
            log = {},
            mode = ArcadeTrackerMode.Face,
            trackerFactory = { m, e -> FaceTracker(m, FaceConfig(smoothingTauNanos = 0L), e) },
        )
        sink.mirror = true
        sink.onFrame(frame, w, h)
        assertTrue(sink.step(clock.nanos))
        val position = input.latest(clock.nanos)
        assertEquals(HandSource.Camera, position.source)
        assertEquals(1f - (0.35f - 0.3f) / 0.4f, position.x, 1e-3f, "nose at 35% of the camera maps to 87.5% of the paddle range, mirrored")
        assertEquals(ArcadeTrackerMode.Face, sink.stats().mode)
        var processed = 1
        repeat(100) {
            clock.advanceMs(10)
            sink.onFrame(frame, w, h)
            if (sink.step(clock.nanos)) processed += 1
        }
        assertTrue(processed in 9..11, "10 Hz face detection: $processed in ~1 s")
        models.faceStatus = -3
        repeat(20) {
            clock.advanceMs(100)
            sink.onFrame(frame, w, h)
            sink.step(clock.nanos)
        }
        assertTrue(requireNotNull(sink.failure).startsWith("native inference failed 3 times in a row"))
        assertTrue(models.closed)
    }

    @Test
    fun sessionBuildsTheFaceTrackerWithItsSettings() {
        var requested: ArcadeTrackerSettings? = null
        val models = FakeHandModels()
        models.faces = listOf(HandShapes.face(0.95f, 320f, 140f))
        val sources = ArrayList<FakeFrameSource>()
        val input = HandPositionInput()
        val session = ArcadeCameraSession(
            FakePermission(granted = true),
            input,
            initialSettings = ArcadeTrackerSettings.DEFAULT,
            landmarkBackendFactory = { s -> requested = s; models },
            nativeGate = NativeSessionGate(),
        ) { sink -> FakeFrameSource(sink).also { sources += it } }
        session.start()
        sources[0].listener!!.onCameraReady(640, 480, true)
        val deadline = System.nanoTime() + 2_000 * ms
        while (input.latest(System.nanoTime()).source != HandSource.Camera && System.nanoTime() < deadline) {
            sources[0].sink.onFrame(frame, w, h)
            Thread.sleep(20)
        }
        assertEquals(ArcadeTrackerSettings.FACE_DEFAULT, requested)
        assertEquals(HandSource.Camera, input.latest(System.nanoTime()).source)
        assertEquals(ArcadeTrackerMode.Face, session.info()!!.diagnostics.mode)
        session.stop(ArcadeStopReason.ExitArcade)
        val end = System.nanoTime() + 2_000 * ms
        while (!models.closed && System.nanoTime() < end) Thread.sleep(10)
        assertTrue(models.closed, "leaving Arcade releases the face model")
    }

    @Test
    fun faceWordingInTheGame() {
        val g = BreakoutGame()
        assertEquals("LOOK AT THE SCREEN TO START", PlaygroundGeometry.banner(g, InputAvailability.HandLost, face = true))
        assertEquals("RAISE YOUR HAND TO START", PlaygroundGeometry.banner(g, InputAvailability.HandLost, face = false))
        g.placeBallForTest(0.5f, 0.3f, 0f, -0.3f)
        g.advance(0.1f, GameInput(0.5f, InputAvailability.HandLost))
        assertEquals("FACE LOST - LOOK AT THE SCREEN TO RESUME", PlaygroundGeometry.banner(g, InputAvailability.HandLost, face = true))
        assertEquals("Tracking face", PlaygroundGeometry.statusLabel(ArcadeStatus.Tracking, face = true))
        assertEquals("Face lost - look at the screen", PlaygroundGeometry.statusLabel(ArcadeStatus.TrackingLost, face = true))
        assertEquals(ArcadeStatus.Tracking.label, PlaygroundGeometry.statusLabel(ArcadeStatus.Tracking, face = false))
        assertEquals(ArcadeStatus.Unavailable.label, PlaygroundGeometry.statusLabel(ArcadeStatus.Unavailable, face = true))
    }
}
