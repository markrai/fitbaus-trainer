// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class BiketrisIntegrationTest {
    private class Rig {
        val input = HandPositionInput()
        val permission = FakePermission(granted = true)
        val sources = ArrayList<FakeFrameSource>()
        val session = ArcadeCameraSession(
            permission,
            input,
            initialSettings = ArcadeTrackerSettings.FACE_DEFAULT,
            landmarkBackendFactory = { FakeHandModels() },
        ) { sink -> FakeFrameSource(sink).also { sources += it } }

        fun sink(i: Int = sources.size - 1): FrameConsumer = sources[i].sink

        fun closeAll() {
            session.stop(ArcadeStopReason.ExitArcade)
        }
    }

    private class RecordingMotion : MotionFrameProcessor {
        var frames = 0
        var faces = 0
        var losses = 0
        var lastMirror: Boolean? = null
        var lastFaceX = Float.NaN
        var lastExtent = Float.NaN

        override fun onFrame(nv21: ByteArray, width: Int, height: Int, mirror: Boolean, nowNanos: Long) {
            frames += 1
            lastMirror = mirror
        }

        override fun onFace(x: Float, y: Float, extent: Float, nowNanos: Long) {
            faces += 1
            lastFaceX = x
            lastExtent = extent
        }

        override fun onFaceLost(nowNanos: Long) {
            losses += 1
        }
    }

    @Test
    fun biketrisActivationAddsWaveDetectionToTheFaceSessionOnly() {
        val rig = Rig()
        rig.session.enableWaveGestures(true)
        rig.session.updateSettings(ArcadeTrackerSettings.FACE_DEFAULT)
        rig.session.start()
        val sink = rig.sink() as LandmarkFrameSink
        assertTrue(sink.motionEnabled)
        assertEquals(1, rig.sources.size, "still exactly one camera source")
        rig.session.stop(ArcadeStopReason.ExitArcade)
        rig.session.enableWaveGestures(false)
        rig.session.start()
        assertFalse((rig.sink() as LandmarkFrameSink).motionEnabled, "other games get no motion processing")
        rig.closeAll()
    }

    @Test
    fun waveDetectionNeverAttachesToNonFaceTrackers() {
        val rig = Rig()
        rig.session.enableWaveGestures(true)
        rig.session.updateSettings(ArcadeTrackerSettings.FINGERS_DEFAULT)
        rig.session.start()
        assertFalse((rig.sink() as LandmarkFrameSink).motionEnabled)
        rig.session.stop(ArcadeStopReason.ExitArcade)
        rig.session.updateSettings(ArcadeTrackerSettings.CLASSICAL)
        rig.session.start()
        assertTrue(rig.sink() is TrackingFrameSink)
        rig.closeAll()
    }

    @Test
    fun stoppingTheCameraDropsEventsAndBumpsTheGeneration() {
        val rig = Rig()
        rig.session.enableWaveGestures(true)
        rig.session.start()
        val gen = rig.session.gestures.generation()
        rig.session.gestures.publish(gen, 1L)
        assertTrue(rig.session.gestures.latest() != null)
        rig.session.stop(ArcadeStopReason.HostPaused)
        assertNull(rig.session.gestures.latest())
        assertFalse(rig.session.gestures.publish(gen, 2L), "the stopped session's detector is cut off")
        rig.session.start()
        assertTrue(rig.session.gestures.generation() != gen)
        assertEquals(2, rig.sources.size)
        assertTrue(rig.sources[0].stops == 1 && rig.sources[1].stops == 0)
        rig.closeAll()
    }

    @Test
    fun landmarkSinkFeedsTheSameFramesAndFaceToTheMotionProcessor() {
        val models = FakeHandModels()
        models.faces = listOf(HandShapes.face(0.9f, 200f, 200f, size = 120f))
        val motion = RecordingMotion()
        val input = HandPositionInput()
        val clock = FakeClock()
        val sink = LandmarkFrameSink(
            backendFactory = { models },
            input = input,
            generation = input.cameraGeneration(),
            settings = ArcadeTrackerSettings.FACE_DEFAULT,
            clock = { clock.nanos },
            startWorker = false,
            gate = NativeSessionGate(),
            log = {},
            mode = ArcadeTrackerMode.Face,
            trackerFactory = { m, e -> FaceTracker(m, FaceConfig(smoothingTauNanos = 0L), e) },
            motion = motion,
        )
        sink.mirror = true
        val frame = ByteArray(640 * 480 * 3 / 2)
        repeat(5) {
            clock.advanceMs(33)
            assertTrue(sink.onFrame(frame, 640, 480))
        }
        assertEquals(5, motion.frames, "every delivered frame, independent of the face rate")
        assertEquals(true, motion.lastMirror)
        assertTrue(sink.step(clock.nanos))
        assertEquals(1, motion.faces)
        assertEquals(200f / 640f, motion.lastFaceX, 1e-3f, "camera-space face x, mirrored only by the detector")
        assertEquals(120f / 640f, motion.lastExtent, 1e-3f)
        models.faces = emptyList()
        clock.advanceMs(200)
        sink.onFrame(frame, 640, 480)
        assertTrue(sink.step(clock.nanos))
        assertEquals(1, motion.losses)
        sink.close()
        assertFalse(sink.onFrame(frame, 640, 480))
        assertEquals(6, motion.frames, "a closed sink stops motion processing")
    }

    @Test
    fun bothCameraPathsFeedTheSameArcadeConsumer() {
        val dir = File("src/main/kotlin/com/fitbaus/arcade")
        val session = File(dir, "ArcadeCameraSession.kt").readText()
        assertTrue(session.contains("PreferExternalCameraFrameSource("))
        assertTrue(session.contains("sink = sink,"))
        assertTrue(Regex("""motion = if \(waveGestures\) WaveMotionProcessor\(gestures, gestures\.generation\(\)\) else null""").containsMatchIn(session))
        assertTrue(File(dir, "Camera1Driver.kt").readText().contains("sink.onFrame(data, frameWidth, frameHeight)"))
        assertTrue(File(dir, "ExternalCamera.kt").readText().contains("sink.onFrame(nv21, width, height)"))
        val sink = File(dir, "LandmarkFrameSink.kt").readText()
        assertTrue(sink.contains("motion?.onFrame(nv21, width, height, mirror, clock())"))
        val biketris = listOf("BiketrisGame.kt", "BiketrisControls.kt", "BiketrisView.kt", "BiketrisSwipeDetector.kt").joinToString("\n") { File(dir, it).readText() }
        for (forbidden in listOf("Camera.open", "UvcNative", "Interpreter", "detectPalms", "landmarks(", "rpm", "Rpm")) {
            assertFalse(biketris.contains(forbidden), forbidden)
        }
        assertEquals(1, Regex("""createBitmap""").findAll(biketris).count(), "only the overlay heatmap allocates a bitmap")
        val view = File(dir, "BiketrisView.kt").readText()
        val heat = view.substring(view.indexOf("private fun drawHeatmap"), view.indexOf("override fun onTouchEvent"))
        assertTrue(heat.contains("if (heatCells.size != cols * rows) {"), "the heatmap bitmap is created once per grid size, not per frame")
    }

    private class Player(private val gestures: WaveGestureInput) {
        val game = BiketrisGame(seed = 21L)
        val session = BiketrisSession(game)
        var nanos = 50_000_000_000L

        fun tick() {
            nanos += 33_000_000L
            session.update(HandPosition(0.5f, 0.5f, 0.9f, nanos, HandSource.Camera), CameraState.Ready, Float.NaN, gestures.latest(), nanos)
        }

        fun run(ms: Long) {
            var left = ms
            while (left > 0) {
                tick()
                left -= 33
            }
        }
    }

    private fun publishRacing(gestures: WaveGestureInput, generation: Int, atNanos: Long, stop: () -> Unit): Boolean {
        val atCommit = CountDownLatch(1)
        val proceed = CountDownLatch(1)
        val result = AtomicBoolean(true)
        gestures.publishCommitHook = {
            atCommit.countDown()
            proceed.await(5, TimeUnit.SECONDS)
        }
        val producer = Thread({ result.set(gestures.publish(generation, atNanos)) }, "fake-camera-thread")
        producer.start()
        try {
            assertTrue(atCommit.await(5, TimeUnit.SECONDS), "producer reached the commit point")
            stop()
        } finally {
            proceed.countDown()
            producer.join(5_000L)
            gestures.publishCommitHook = null
        }
        assertFalse(producer.isAlive)
        return result.get()
    }

    private fun raceScenario(stop: (Rig, Player) -> Unit): Pair<Boolean, Player> {
        val rig = Rig()
        rig.session.enableWaveGestures(true)
        rig.session.start()
        val player = Player(rig.session.gestures)
        player.run(800)
        assertTrue(player.session.live)
        val oldGeneration = rig.session.gestures.generation()
        val published = publishRacing(rig.session.gestures, oldGeneration, player.nanos) { stop(rig, player) }
        player.run(1000)
        rig.closeAll()
        return published to player
    }

    @Test
    fun theRaceHarnessDoesRotateWhenNothingStopsTheCamera() {
        val (published, player) = raceScenario { _, _ -> }
        assertTrue(published)
        assertEquals(1, player.session.waveRotations, "the same event rotates once when the session is still current")
    }

    @Test
    fun aClearInsideThePublishWindowRejectsTheEventOnTheSameThread() {
        val input = WaveGestureInput()
        val generation = input.generation()
        input.publishCommitHook = { input.clear() }
        assertFalse(input.publish(generation, 1L))
        input.publishCommitHook = null
        assertNull(input.latest(), "the event checked before clear never became visible")
        assertTrue(input.publish(input.generation(), 2L))
    }

    @Test
    fun aProducerRacingTrackerReconfigurationNeverRotatesAPiece() {
        val (published, player) = raceScenario { rig, _ ->
            rig.session.updateSettings(ArcadeTrackerSettings(ArcadeTrackerMode.Face, 15f, 1))
            rig.session.stop(ArcadeStopReason.HostPaused)
            rig.session.start()
        }
        assertFalse(published)
        assertEquals(0, player.session.waveRotations)
        assertEquals(0, player.game.rotation)
        assertEquals(0, player.session.discardedWaves, "nothing old was ever visible to discard")
    }

    @Test
    fun aProducerRacingAModeSwitchAndReturnNeverRotatesAPiece() {
        val (published, player) = raceScenario { rig, p ->
            p.session.pause()
            rig.session.stop(ArcadeStopReason.ExitArcade)
            rig.session.enableWaveGestures(false)
            rig.session.start()
            rig.session.stop(ArcadeStopReason.ExitArcade)
            rig.session.enableWaveGestures(true)
            rig.session.start()
        }
        assertFalse(published)
        assertEquals(0, player.session.waveRotations)
        assertEquals(0, player.game.rotation)
    }

    @Test
    fun aProducerRacingAHostPauseAndResumeNeverRotatesAPiece() {
        val (published, player) = raceScenario { rig, p ->
            p.session.pause()
            rig.session.stop(ArcadeStopReason.HostPaused)
            rig.session.start()
        }
        assertFalse(published)
        assertEquals(0, player.session.waveRotations)
    }

    @Test
    fun aProducerRacingAGameRestartNeverRotatesTheNewGame() {
        val (_, player) = raceScenario { _, p -> p.session.restart(77L) }
        assertEquals(0, player.session.waveRotations, "the event from before the restart is absorbed")
        assertEquals(0, player.game.rotation)
        assertEquals(BiketrisGame(seed = 77L).piece, player.game.piece)
    }

    @Test
    fun existingGamesKeepTheirTrackerPresets() {
        assertEquals(ArcadeTrackerSettings(ArcadeTrackerMode.Face, 10f, 1), ArcadeTrackerSettings.FACE_DEFAULT)
        assertEquals(ArcadeTrackerSettings.FACE_DEFAULT, ArcadeTrackerSettings.faceFromKey(null))
        assertEquals(listOf(10f, 15f), ArcadeTrackerSettings.FACE_PRESETS.map { it.landmarkHz })
        assertTrue(ArcadeTrackerSettings.FACE_PRESETS.all { it.mode == ArcadeTrackerMode.Face && it.landmarkThreads == 1 })
        assertEquals(ArcadeTrackerSettings(ArcadeTrackerMode.Fingers, 2f, 2), ArcadeTrackerSettings.FINGERS_DEFAULT)
    }
}
