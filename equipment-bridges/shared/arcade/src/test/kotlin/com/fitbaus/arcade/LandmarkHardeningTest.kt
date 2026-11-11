// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class LandmarkHardeningTest {
    private val w = 640
    private val h = 480
    private val ms = 1_000_000L
    private val frame = ByteArray(w * h * 3 / 2)

    private fun hand(x: Float = 320f, presence: Float = 0.99f, handedness: Float = 0.95f) =
        HandShapes.landmarks(presence, handedness, x, 360f)

    private fun trackingModels(): FakeHandModels = FakeHandModels().also {
        it.palms = listOf(HandShapes.palm(0.9f, 320f, 360f))
        it.responder = { hand() }
    }

    @Test
    fun everyLossHasAReason() {
        val models = trackingModels()
        val events = ArrayList<String>()
        val t = LandmarkHandTracker(models, LandmarkConfig(smoothingTauNanos = 0L), events::add)
        var now = 0L
        fun next(): LandmarkPoint? {
            now += 200 * ms
            return t.process(frame, w, h, now)
        }
        requireNotNull(next())
        models.responder = { hand(presence = 0.2f) }
        assertNull(next())
        models.responder = { hand() }
        requireNotNull(next())
        models.responder = { hand(x = 320f + 0.6f * w) }
        assertNull(next())
        models.responder = { hand() }
        requireNotNull(next())
        models.responder = { hand(handedness = 0.02f) }
        assertTrue(next() != null)
        assertNull(next())
        models.responder = { hand() }
        requireNotNull(next())
        models.responder = { null }
        assertNull(next())
        assertEquals(1, t.losses(LossReason.Presence))
        assertEquals(1, t.losses(LossReason.WristJump))
        assertEquals(1, t.losses(LossReason.Handedness))
        assertEquals(1, t.losses(LossReason.BackendError))
        assertEquals(0, t.losses(LossReason.Region))
        assertEquals(4, t.lossCount)
        assertTrue(events.any { it.startsWith("lost track: Presence - presence 0.200") }, "$events")
        assertTrue(events.any { it.startsWith("lost track: WristJump") })
        assertTrue(events.any { it.startsWith("lost track: BackendError - landmark inference failed (status -3)") })
        assertTrue(events.count { it.startsWith("acquired ") } >= 4)
    }

    @Test
    fun regionRejectionIsCounted() {
        val models = trackingModels()
        val t = LandmarkHandTracker(models, LandmarkConfig(smoothingTauNanos = 0L, maxJumpFraction = 5f))
        requireNotNull(t.process(frame, w, h, 0L))
        models.responder = { hand(x = w + 500f) }
        assertNull(t.process(frame, w, h, 200 * ms))
        assertEquals(1, t.losses(LossReason.Region))
    }

    @Test
    fun unsuccessfulSearchReportsItsInferenceCost() {
        val models = FakeHandModels()
        models.palmInferenceMs = 163f
        val t = LandmarkHandTracker(models)
        assertNull(t.process(frame, w, h, 0L))
        assertTrue(t.lastUpdateSearched)
        assertEquals(163f, t.lastInferenceMs)
        models.palms = listOf(HandShapes.palm(0.9f, 320f, 360f))
        models.responder = { hand(presence = 0.1f) }
        assertNull(t.process(frame, w, h, 200 * ms))
        assertEquals(163f + 90f + 0f, t.lastInferenceMs, 0.01f, "palm plus the rejected landmark run")
    }

    @Test
    fun backendErrorsAreNotNoHandResults() {
        val models = FakeHandModels()
        models.palmStatus = -3
        val events = ArrayList<String>()
        val t = LandmarkHandTracker(models, LandmarkConfig(), events::add)
        repeat(2) { assertNull(t.process(frame, w, h, it * 200 * ms)) }
        assertEquals(2, t.backendErrors)
        assertEquals(2, t.consecutiveBackendErrors)
        assertEquals(-3, t.lastBackendStatus)
        assertTrue(events.all { it == "palm inference failed (status -3)" })
        models.palmStatus = null
        assertNull(t.process(frame, w, h, 400 * ms))
        assertEquals(0, t.consecutiveBackendErrors, "a real no-hand result resets the error streak")
        assertEquals(2, t.backendErrors)
    }

    private class SinkRig(
        val models: FakeHandModels,
        hz: Float = 5f,
        config: LandmarkConfig = LandmarkConfig(smoothingTauNanos = 0L),
        val gate: NativeSessionGate = NativeSessionGate(),
    ) {
        val clock = FakeClock()
        val input = HandPositionInput()
        val logs = ArrayList<String>()
        val sink = LandmarkFrameSink(
            backendFactory = { models },
            input = input,
            generation = input.cameraGeneration(),
            settings = ArcadeTrackerSettings(ArcadeTrackerMode.Landmark, hz, 2),
            config = config,
            clock = { clock.nanos },
            startWorker = false,
            gate = gate,
            log = { logs += it },
        )

        fun runFor(totalMs: Long, frameMs: Long = 10): Int {
            var processed = 0
            var elapsed = 0L
            while (elapsed < totalMs) {
                sink.onFrame(ByteArray(640 * 480 * 3 / 2), 640, 480)
                if (sink.step(clock.nanos)) processed += 1
                clock.advanceMs(frameMs)
                elapsed += frameMs
            }
            return processed
        }
    }

    @Test
    fun noHandSearchDropsToTheIdleRateAfterTheInitialWindow() {
        val rig = SinkRig(FakeHandModels())
        val initial = rig.runFor(3_000)
        assertTrue(initial in 14..16, "initial 3 s searches at the tracking rate: $initial")
        val idle = rig.runFor(10_000)
        assertTrue(idle in 14..16, "then about 1.5 Hz: $idle in 10 s")
        assertEquals(rig.sink.searchUpdates, rig.sink.processedFrames)
        assertEquals(0L, rig.sink.trackUpdates)
    }

    @Test
    fun trackingStaysAt5HzAndLossOpensAFastReacquisitionWindow() {
        val models = trackingModels()
        val rig = SinkRig(models)
        val tracked = rig.runFor(4_000)
        assertTrue(tracked in 19..21, "5 Hz while tracking: $tracked")
        models.palms = emptyList()
        models.responder = { hand(presence = 0.05f) }
        val afterLoss = rig.runFor(2_000)
        assertTrue(afterLoss in 9..11, "full-rate search for 2 s after a loss: $afterLoss")
        val idle = rig.runFor(6_000)
        assertTrue(idle in 8..10, "idle search afterwards: $idle in 6 s")
        val stats = rig.sink.stats()
        assertEquals(1, stats.trackingLosses)
        assertEquals(1, stats.lossPresence)
        assertTrue(stats.trackUpdates >= 19)
        assertEquals(160f + 0f, stats.searchInferenceP50Ms, 0.01f)
        assertEquals(90f, stats.trackInferenceP50Ms, 0.01f)
    }

    @Test
    fun handAppearingDuringIdleSearchIsAcquiredWithinOneIdlePeriod() {
        val models = FakeHandModels()
        val rig = SinkRig(models)
        rig.runFor(6_000)
        models.palms = listOf(HandShapes.palm(0.9f, 320f, 360f))
        models.responder = { hand() }
        val appearedAt = rig.clock.nanos
        while (rig.input.latest(rig.clock.nanos).source != HandSource.Camera) rig.runFor(33)
        val delayMs = (rig.clock.nanos - appearedAt) / ms
        assertTrue(delayMs <= 700, "acquired within one idle period: $delayMs ms")
    }

    @Test
    fun repeatedBackendErrorsFailTheTrackerVisibly() {
        val models = FakeHandModels()
        models.palmStatus = -3
        val rig = SinkRig(models)
        rig.runFor(2_000)
        val stats = rig.sink.stats()
        assertEquals(3, stats.backendErrors)
        val failure = requireNotNull(rig.sink.failure)
        assertTrue(failure.startsWith("native inference failed 3 times in a row (status -3)"), failure)
        assertTrue(models.closed, "native models released on failure")
        assertEquals(1, rig.gate.available, "native session slot released on failure")
        assertFalse(rig.sink.onFrame(ByteArray(640 * 480 * 3 / 2), 640, 480))
        assertTrue(rig.logs.contains(failure))
    }

    @Test
    fun sessionShowsATrackerFailureAsUnavailable() {
        val models = FakeHandModels()
        models.palmStatus = -3
        val sources = ArrayList<FakeFrameSource>()
        val session = ArcadeCameraSession(
            FakePermission(granted = true),
            HandPositionInput(),
            initialSettings = ArcadeTrackerSettings.LANDMARK_DEFAULT,
            landmarkBackendFactory = { models },
            nativeGate = NativeSessionGate(),
        ) { sink -> FakeFrameSource(sink).also { sources += it } }
        session.start()
        sources[0].listener!!.onCameraReady(640, 480, true)
        assertEquals(CameraState.Ready, session.state())
        val sink = sources[0].sink
        val deadline = System.nanoTime() + 3_000 * ms
        while (sink.failure == null && System.nanoTime() < deadline) {
            sink.onFrame(ByteArray(640 * 480 * 3 / 2), 640, 480)
            Thread.sleep(20)
        }
        assertEquals(CameraState.Unavailable, session.state(), "a failed tracker is never shown as a missing hand")
        assertTrue(session.failureReason()!!.startsWith("native inference failed"))
        assertEquals(ArcadeStatus.Unavailable, ArcadeStatusResolver.resolve(session.state(), false, false))
        val info = requireNotNull(session.info())
        assertTrue(info.diagnostics.failed)
        session.stop(ArcadeStopReason.ExitArcade)
        assertEquals(CameraState.Off, session.state())
    }

    @Test
    fun nativeSessionsNeverOverlap() {
        val gate = NativeSessionGate()
        val active = AtomicInteger(0)
        val maxActive = AtomicInteger(0)
        val firstInside = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        fun backend(block: Boolean): HandModelBackend = object : HandModelBackend {
            init {
                maxActive.accumulateAndGet(active.incrementAndGet()) { a, b -> maxOf(a, b) }
            }

            override fun detectPalms(frame: ByteArray, width: Int, height: Int, minScore: Float, out: FloatArray, maxOut: Int, times: FloatArray): Int {
                if (block) {
                    firstInside.countDown()
                    releaseFirst.await(2, TimeUnit.SECONDS)
                }
                return 0
            }

            override fun landmarks(frame: ByteArray, width: Int, height: Int, roi: HandRoi, out: FloatArray, times: FloatArray): Int = 0

            override fun detectFaces(frame: ByteArray, width: Int, height: Int, minScore: Float, out: FloatArray, maxOut: Int, times: FloatArray): Int = 0

            override fun renderPreview(frame: ByteArray, width: Int, height: Int, cols: Int, rows: Int, mirror: Boolean, out: IntArray) {
            }

            override fun close() {
                active.decrementAndGet()
            }
        }
        val input = HandPositionInput()
        fun sink(block: Boolean) = LandmarkFrameSink(
            backendFactory = { backend(block) },
            input = input,
            generation = input.cameraGeneration(),
            settings = ArcadeTrackerSettings.LANDMARK_DEFAULT,
            gate = gate,
            log = {},
        )
        val first = sink(block = true)
        first.onFrame(frame, w, h)
        assertTrue(firstInside.await(2, TimeUnit.SECONDS))
        val second = sink(block = false)
        val stopStarted = System.nanoTime()
        first.close()
        assertTrue((System.nanoTime() - stopStarted) / ms < 50, "close never waits for native work")
        val deadline = System.nanoTime() + 2_000 * ms
        while (second.processedFrames == 0L && System.nanoTime() < deadline) {
            second.onFrame(frame, w, h)
            Thread.sleep(20)
            if (second.processedFrames == 0L && maxActive.get() == 1) releaseFirst.countDown()
        }
        assertTrue(second.processedFrames > 0, "the new session starts once the old one is released")
        assertEquals(1, maxActive.get(), "never two native sessions at once")
        second.close()
        val end = System.nanoTime() + 2_000 * ms
        while ((active.get() != 0 || gate.available != 1) && System.nanoTime() < end) Thread.sleep(10)
        assertEquals(0, active.get(), "all native sessions released")
        assertEquals(1, gate.available)
    }

    @Test
    fun closingWhileWaitingForTheNativeSlotNeverCreatesASession() {
        val gate = NativeSessionGate()
        assertTrue(gate.acquire(1_000_000L) { true })
        var created = 0
        val input = HandPositionInput()
        val waiting = LandmarkFrameSink(
            backendFactory = { created += 1; FakeHandModels() },
            input = input,
            generation = input.cameraGeneration(),
            settings = ArcadeTrackerSettings.LANDMARK_DEFAULT,
            gate = gate,
            log = {},
        )
        waiting.onFrame(frame, w, h)
        Thread.sleep(300)
        waiting.close()
        Thread.sleep(300)
        gate.release()
        Thread.sleep(200)
        assertEquals(0, created)
        assertEquals(1, gate.available)
    }

    @Test
    fun summaryShowsSearchTrackAndLossReasons() {
        val diagnostics = ArcadeTrackerDiagnostics(
            mode = ArcadeTrackerMode.Landmark, processedHz = 4.9f, processingP50Ms = 120f, processingP90Ms = 160f,
            inferenceP50Ms = 100f, frameAgeP50Ms = 15f, framesSuperseded = 300, trackingLosses = 3, reacquisitions = 2,
            processCpuPercent = 140f, lastError = null, searchUpdates = 12, trackUpdates = 200, searchP50Ms = 210f,
            trackP50Ms = 118f, trackP90Ms = 140f, searchInferenceP50Ms = 165f, trackInferenceP50Ms = 95f,
            lossPresence = 2, lossRegion = 0, lossWristJump = 1, lossHandedness = 0, lossBackend = 0,
        )
        val text = ArcadeCameraInfo(640, 480, true, 212, 0, diagnostics).summary("Landmark 5 Hz, 2 threads")
        assertEquals(
            "Landmark 5 Hz, 2 threads  4.9 Hz  track 200: 118/140 ms (infer 95)  search 12: 210 ms (infer 165)  age 15 ms  " +
                "skipped 300  lost 3 [presence 2 region 0 jump 1 hand 0 err 0]  reacq 2  cpu 140%",
            text,
        )
    }
}
