// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class LandmarkFrameSinkTest {
    private val w = 640
    private val h = 480
    private val ms = 1_000_000L

    private class Rig(
        hz: Float = 5f,
        val models: FakeHandModels = FakeHandModels(),
        failFactory: Boolean = false,
        worker: Boolean = false,
        val gate: NativeSessionGate = NativeSessionGate(),
        config: LandmarkConfig = LandmarkConfig(smoothingTauNanos = 0L),
    ) {
        val clock = FakeClock()
        val logs = java.util.Collections.synchronizedList(ArrayList<String>())
        val input = HandPositionInput()
        val preview = ArcadePreview()
        var factoryCalls = 0
        val sink = LandmarkFrameSink(
            backendFactory = {
                factoryCalls += 1
                if (failFactory) throw IllegalStateException("cannot load TFLite runtime") else models
            },
            input = input,
            generation = input.cameraGeneration(),
            settings = ArcadeTrackerSettings(ArcadeTrackerMode.Landmark, hz, 2),
            config = config,
            preview = preview,
            clock = if (worker) ({ System.nanoTime() }) else ({ clock.nanos }),
            startWorker = worker,
            gate = gate,
            log = { logs += it },
        )
    }

    private fun frame(marker: Int): ByteArray = ByteArray(w * h * 3 / 2).also { it[0] = marker.toByte() }

    private fun visibleHand(models: FakeHandModels) {
        models.palms = listOf(HandShapes.palm(0.9f, 320f, 360f))
        models.responder = { HandShapes.landmarks(0.99f, 0.9f, 320f, 360f) }
    }

    @Test
    fun onlyTheNewestFrameIsProcessed() {
        val rig = Rig()
        visibleHand(rig.models)
        for (i in 1..6) {
            assertTrue(rig.sink.onFrame(frame(i), w, h))
            rig.clock.advanceMs(33)
        }
        assertTrue(rig.sink.step(rig.clock.nanos))
        assertEquals(6.toByte(), rig.models.lastFrameMarker, "inference ran on the latest frame")
        assertEquals(5L, rig.sink.framesSuperseded, "older frames were replaced, never queued")
        assertFalse(rig.sink.step(rig.clock.nanos), "a consumed frame is never processed twice")
        assertEquals(1L, rig.sink.processedFrames)
    }

    @Test
    fun updatesArePacedToTheConfiguredRate() {
        val rig = Rig(hz = 5f)
        visibleHand(rig.models)
        rig.sink.onFrame(frame(1), w, h)
        assertTrue(rig.sink.step(rig.clock.nanos))
        var processed = 1
        for (i in 0 until 60) {
            rig.clock.advanceMs(33)
            rig.sink.onFrame(frame(i), w, h)
            if (rig.sink.step(rig.clock.nanos)) processed += 1
        }
        val seconds = 60 * 33 / 1000.0
        val expected = 1 + (seconds * 5).toInt()
        assertTrue(kotlin.math.abs(expected - processed) <= 1, "about 5 updates per second of 30 fps frames: $processed vs $expected")
        assertTrue(rig.sink.framesSuperseded >= 45, "most camera frames are superseded: ${rig.sink.framesSuperseded}")
    }

    @Test
    fun slowInferenceDoesNotBuildABacklog() {
        val rig = Rig(hz = 10f)
        visibleHand(rig.models)
        rig.sink.onFrame(frame(1), w, h)
        assertTrue(rig.sink.step(rig.clock.nanos))
        rig.clock.advanceMs(450)
        for (i in 2..9) rig.sink.onFrame(frame(i), w, h)
        assertTrue(rig.sink.step(rig.clock.nanos))
        assertEquals(9.toByte(), rig.models.lastFrameMarker)
        assertFalse(rig.sink.step(rig.clock.nanos), "no catch-up burst after a long gap")
    }

    @Test
    fun publishesMirroredPositionUnderItsGeneration() {
        val rig = Rig()
        visibleHand(rig.models)
        rig.sink.mirror = true
        rig.sink.onFrame(frame(1), w, h)
        rig.sink.step(rig.clock.nanos)
        val position = rig.input.latest(rig.clock.nanos)
        assertEquals(HandSource.Camera, position.source)
        assertEquals(1f - (320f - 24f) / w, position.x, 1e-3f, "front camera mirrored, index fingertip")
        rig.input.clearCamera()
        rig.clock.advanceMs(200)
        rig.sink.onFrame(frame(2), w, h)
        rig.sink.step(rig.clock.nanos)
        assertEquals(HandSource.Lost, rig.input.latest(rig.clock.nanos).source, "a stopped session cannot publish")
    }

    @Test
    fun noHandPublishesNothing() {
        val rig = Rig()
        rig.sink.onFrame(frame(1), w, h)
        assertTrue(rig.sink.step(rig.clock.nanos))
        assertEquals(HandSource.Lost, rig.input.latest(rig.clock.nanos).source)
        assertEquals(1, rig.models.palmCalls)
    }

    @Test
    fun backendFailureIsReportedOnceWithoutRetryStorm() {
        val rig = Rig(failFactory = true)
        repeat(5) {
            rig.sink.onFrame(frame(it), w, h)
            rig.sink.step(rig.clock.nanos)
            rig.clock.advanceMs(250)
        }
        assertEquals(1, rig.factoryCalls)
        val error = requireNotNull(rig.sink.stats().lastError)
        assertTrue(error.contains("cannot load TFLite runtime"), error)
    }

    @Test
    fun closeReleasesTheModelsAndRejectsFrames() {
        val rig = Rig()
        visibleHand(rig.models)
        rig.sink.onFrame(frame(1), w, h)
        rig.sink.step(rig.clock.nanos)
        rig.sink.close()
        assertTrue(rig.models.closed)
        assertFalse(rig.sink.onFrame(frame(2), w, h))
        assertFalse(rig.sink.step(rig.clock.nanos + 1_000 * ms))
    }

    @Test
    fun statsReportTimingAgeLossAndReacquisition() {
        val rig = Rig()
        var presence = 0.99f
        rig.models.palms = listOf(HandShapes.palm(0.9f, 320f, 360f))
        rig.models.responder = { HandShapes.landmarks(presence, 0.9f, 320f, 360f) }
        rig.sink.onFrame(frame(1), w, h)
        rig.clock.advanceMs(40)
        rig.sink.step(rig.clock.nanos)
        presence = 0.1f
        rig.clock.advanceMs(160)
        rig.sink.onFrame(frame(2), w, h)
        rig.clock.advanceMs(40)
        rig.sink.step(rig.clock.nanos)
        presence = 0.99f
        rig.clock.advanceMs(160)
        rig.sink.onFrame(frame(3), w, h)
        rig.clock.advanceMs(40)
        rig.sink.step(rig.clock.nanos)
        val stats = rig.sink.stats()
        assertEquals(ArcadeTrackerMode.Landmark, stats.mode)
        assertEquals(3L, stats.processedFrames)
        assertEquals(1, stats.trackingLosses)
        assertEquals(1, stats.reacquisitions)
        assertEquals(40f, stats.frameAgeP50Ms, 0.01f, "frame age = wait between camera arrival and inference start")
        assertTrue(stats.inferenceP50Ms >= 90f, "inference timings come from the model backend: ${stats.inferenceP50Ms}")
    }

    @Test
    fun previewShowsTheProcessedFrame() {
        val rig = Rig()
        visibleHand(rig.models)
        rig.sink.onFrame(frame(77), w, h)
        rig.sink.step(rig.clock.nanos)
        val snapshot = PreviewSnapshot()
        assertTrue(rig.preview.copyTo(snapshot))
        assertEquals(80, snapshot.width)
        assertEquals(60, snapshot.height)
        assertEquals(77, snapshot.pixels[0] and 0xFF)
        assertFalse(snapshot.pointX.isNaN())
    }

    @Test
    fun workerThreadProcessesLatestFramesAtTheConfiguredRate() {
        val models = FakeHandModels()
        visibleHand(models)
        val rig = Rig(hz = 5f, models = models, worker = true)
        val start = System.nanoTime()
        var i = 0
        while (System.nanoTime() - start < 1_050 * ms) {
            rig.sink.onFrame(frame(i++), w, h)
            Thread.sleep(33)
        }
        rig.sink.close()
        val deadline = System.nanoTime() + 2_000 * ms
        while (!models.closed && System.nanoTime() < deadline) Thread.sleep(10)
        assertTrue(models.closed, "worker releases the models when closed")
        val processed = rig.sink.processedFrames
        assertTrue(processed in 4..7, "about 5 updates in ~1 s: $processed")
        assertTrue(rig.sink.framesSuperseded > 15, "frames superseded: ${rig.sink.framesSuperseded}")
    }
}
