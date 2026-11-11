// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TrackerSelectionTest {
    private val ms = 1_000_000L

    private class Rig(settings: ArcadeTrackerSettings, factory: ((ArcadeTrackerSettings) -> HandModelBackend)? = null) {
        val input = HandPositionInput()
        val sources = ArrayList<FakeFrameSource>()
        var cpuMs = 0L
        var wallNanos = 0L
        val session = ArcadeCameraSession(
            FakePermission(granted = true),
            input,
            initialSettings = settings,
            landmarkBackendFactory = factory,
            cpuClockMs = { cpuMs },
            wallClockNanos = { wallNanos },
            nativeGate = NativeSessionGate(),
        ) { sink -> FakeFrameSource(sink).also { sources += it } }

        fun startReady() {
            session.start()
            sources.last().listener!!.onCameraReady(640, 480, true)
        }
    }

    private fun waitUntil(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 2_000_000_000L
        while (!condition() && System.nanoTime() < deadline) Thread.sleep(10)
    }

    @Test
    fun faceIsTheBreakoutDefaultAndClassicalStaysAvailable() {
        assertEquals(ArcadeTrackerSettings.FACE_DEFAULT, ArcadeTrackerSettings.DEFAULT)
        assertEquals(ArcadeTrackerSettings(ArcadeTrackerMode.Face, 10f, 1), ArcadeTrackerSettings.DEFAULT)
        assertEquals(ArcadeTrackerSettings.DEFAULT, ArcadeTrackerSettings.fromKey(null))
        assertEquals(ArcadeTrackerSettings.DEFAULT, ArcadeTrackerSettings.fromKey("unknown"))
        assertEquals(ArcadeTrackerSettings.CLASSICAL, ArcadeTrackerSettings.fromKey("classical"))
        assertEquals("Face 10 Hz, 1 thread", ArcadeTrackerSettings.DEFAULT.label)
        val rig = Rig(ArcadeTrackerSettings.CLASSICAL)
        rig.startReady()
        assertTrue(rig.sources[0].sink is TrackingFrameSink)
        assertEquals(ArcadeTrackerMode.Classical, rig.session.info()!!.diagnostics.mode)
    }

    @Test
    fun presetsRoundTripAndStartAt5HzWithTwoThreads() {
        assertEquals(ArcadeTrackerSettings(ArcadeTrackerMode.Landmark, 5f, 2), ArcadeTrackerSettings.LANDMARK_DEFAULT)
        for (preset in ArcadeTrackerSettings.PRESETS) assertEquals(preset, ArcadeTrackerSettings.fromKey(preset.key))
        assertEquals("Landmark 5 Hz, 2 threads", ArcadeTrackerSettings.LANDMARK_DEFAULT.label)
        assertEquals("Landmark 3 Hz, 1 thread", ArcadeTrackerSettings(ArcadeTrackerMode.Landmark, 3f, 1).label)
    }

    @Test
    fun landmarkModeUsesOneLandmarkConsumerWithItsThreadCount() {
        var threads = -1
        val models = FakeHandModels()
        val rig = Rig(ArcadeTrackerSettings.LANDMARK_DEFAULT) { s -> threads = s.landmarkThreads; models }
        rig.startReady()
        val sink = rig.sources[0].sink
        assertTrue(sink is LandmarkFrameSink, "exactly one tracker: the landmark consumer")
        sink.onFrame(ByteArray(640 * 480 * 3 / 2), 640, 480)
        waitUntil { threads != -1 }
        assertEquals(2, threads)
        rig.session.stop(ArcadeStopReason.ExitArcade)
        waitUntil { models.closed }
        assertTrue(models.closed, "stopping the session releases the native models")
    }

    @Test
    fun landmarkHoldTimingMatchesTheUpdateRate() {
        val rig = Rig(ArcadeTrackerSettings.LANDMARK_DEFAULT) { FakeHandModels() }
        rig.startReady()
        val gen = rig.input.cameraGeneration()
        rig.input.publishCamera(0.3f, 0.5f, 1f, 0L, gen)
        val between = rig.input.latest(250 * ms)
        assertEquals(HandSource.Camera, between.source)
        assertEquals(1f, between.confidence, "still fresh between 5 Hz updates")
        assertEquals(HandSource.Camera, rig.input.latest(500 * ms).source)
        assertEquals(HandSource.Lost, rig.input.latest(501 * ms).source, "LOST after 2.5 update periods")
        rig.session.stop(ArcadeStopReason.ExitArcade)
        rig.session.updateSettings(ArcadeTrackerSettings(ArcadeTrackerMode.Landmark, 3f, 1))
        rig.startReady()
        val gen3 = rig.input.cameraGeneration()
        rig.input.publishCamera(0.3f, 0.5f, 1f, 0L, gen3)
        assertEquals(HandSource.Camera, rig.input.latest(800 * ms).source, "3 Hz holds for 833 ms")
        rig.session.stop(ArcadeStopReason.ExitArcade)
        rig.session.updateSettings(ArcadeTrackerSettings.CLASSICAL)
        rig.startReady()
        val genC = rig.input.cameraGeneration()
        rig.input.publishCamera(0.3f, 0.5f, 1f, 0L, genC)
        assertTrue(rig.input.latest(250 * ms).confidence < 1f, "classical timing restored")
        assertEquals(HandSource.Lost, rig.input.latest(501 * ms).source)
    }

    @Test
    fun settingsChangeAppliesAtTheNextStart() {
        val rig = Rig(ArcadeTrackerSettings.CLASSICAL) { FakeHandModels() }
        rig.startReady()
        rig.session.updateSettings(ArcadeTrackerSettings.LANDMARK_DEFAULT)
        assertTrue(rig.sources[0].sink is TrackingFrameSink, "the running session is not swapped underneath")
        rig.session.stop(ArcadeStopReason.HostPaused)
        rig.startReady()
        assertTrue(rig.sources[1].sink is LandmarkFrameSink)
        assertEquals(ArcadeTrackerSettings.LANDMARK_DEFAULT, rig.session.settings)
    }

    @Test
    fun unavailableLandmarkBackendIsReportedInDiagnostics() {
        val rig = Rig(ArcadeTrackerSettings.LANDMARK_DEFAULT, factory = null)
        rig.startReady()
        rig.sources[0].sink.onFrame(ByteArray(640 * 480 * 3 / 2), 640, 480)
        waitUntil { rig.session.info()?.diagnostics?.lastError != null }
        val error = requireNotNull(rig.session.info()!!.diagnostics.lastError)
        assertTrue(error.startsWith("landmark tracker unavailable"), error)
        assertEquals(ArcadeTrackerMode.Landmark, rig.session.info()!!.diagnostics.mode)
        rig.session.stop(ArcadeStopReason.ExitArcade)
    }

    @Test
    fun processCpuIsMeasuredOverOneSecondWindows() {
        val rig = Rig(ArcadeTrackerSettings.CLASSICAL)
        rig.startReady()
        rig.cpuMs = 10_000L
        rig.wallNanos = 5_000 * ms
        assertTrue(rig.session.info()!!.diagnostics.processCpuPercent.isNaN())
        rig.cpuMs += 450L
        rig.wallNanos += 500 * ms
        assertTrue(rig.session.info()!!.diagnostics.processCpuPercent.isNaN(), "window not complete")
        rig.cpuMs += 450L
        rig.wallNanos += 500 * ms
        assertEquals(90f, rig.session.info()!!.diagnostics.processCpuPercent, 0.01f)
        assertFalse(rig.session.info() == null)
    }
}
