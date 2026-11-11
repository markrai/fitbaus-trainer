// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FingerSessionTest {
    private val frame = ByteArray(640 * 480 * 3 / 2)

    private class Rig(settings: ArcadeTrackerSettings, factory: ((ArcadeTrackerSettings) -> HandModelBackend)?) {
        val input = HandPositionInput()
        val sources = ArrayList<FakeFrameSource>()
        val session = ArcadeCameraSession(
            FakePermission(granted = true),
            input,
            initialSettings = settings,
            landmarkBackendFactory = factory,
            nativeGate = NativeSessionGate(),
        ) { sink -> FakeFrameSource(sink).also { sources += it } }

        fun startReady() {
            session.start()
            sources.last().listener!!.onCameraReady(640, 480, true)
        }
    }

    private fun waitUntil(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 3_000_000_000L
        while (!condition() && System.nanoTime() < deadline) Thread.sleep(10)
    }

    private fun twoHands(): FakeHandModels = FakeHandModels().also {
        it.show(
            SceneHand(SyntheticHands.points(SyntheticHands.showing(5), 150f, 400f)),
            SceneHand(SyntheticHands.points(SyntheticHands.showing(2), 480f, 400f)),
        )
    }

    @Test
    fun fingerPresetsStartAtTwoHertzWithTwoThreadsAndStaySeparateFromBricks() {
        assertEquals(ArcadeTrackerSettings(ArcadeTrackerMode.Fingers, 2f, 2), ArcadeTrackerSettings.FINGERS_DEFAULT)
        assertEquals("Fingers 2 Hz, 2 threads", ArcadeTrackerSettings.FINGERS_DEFAULT.label)
        for (preset in ArcadeTrackerSettings.FINGER_PRESETS) {
            assertEquals(ArcadeTrackerMode.Fingers, preset.mode)
            assertEquals(preset, ArcadeTrackerSettings.fingersFromKey(preset.key))
            assertEquals(ArcadeTrackerSettings.DEFAULT, ArcadeTrackerSettings.fromKey(preset.key), "Bricks never runs the finger pipeline")
        }
        assertEquals(ArcadeTrackerSettings.FINGERS_DEFAULT, ArcadeTrackerSettings.fingersFromKey(null))
        assertEquals(ArcadeTrackerSettings.FINGERS_DEFAULT, ArcadeTrackerSettings.fingersFromKey(ArcadeTrackerSettings.FACE_DEFAULT.key))
        assertTrue(ArcadeTrackerSettings.PRESETS.none { it.mode == ArcadeTrackerMode.Fingers })
        assertEquals(ArcadeTrackerSettings.FACE_DEFAULT, ArcadeTrackerSettings.DEFAULT, "Breakout keeps its face default")
    }

    @Test
    fun fingersModeFeedsTheTypedInputAndReleasesEverythingOnStop() {
        val models = twoHands()
        var opened: ArcadeTrackerSettings? = null
        val rig = Rig(ArcadeTrackerSettings.FINGERS_DEFAULT) { s -> opened = s; models }
        rig.startReady()
        val sink = rig.sources[0].sink
        assertTrue(sink is LandmarkFrameSink)
        sink.onFrame(frame, 640, 480)
        waitUntil { rig.session.fingers.read(System.nanoTime()).state != FingerInputState.NoSignal }
        val reading = rig.session.fingers.read(System.nanoTime())
        assertEquals(FingerInputState.Unstable, reading.state)
        assertEquals(7, reading.total)
        assertEquals(ArcadeTrackerSettings.FINGERS_DEFAULT, opened)
        assertEquals(ArcadeTrackerMode.Fingers, rig.session.info()!!.diagnostics.mode)
        assertFalse(rig.input.hasEverTracked(), "finger counting never drives the paddle input")
        rig.session.stop(ArcadeStopReason.ExitArcade)
        waitUntil { models.closed }
        assertTrue(models.closed, "native models released when leaving the game")
        assertEquals(FingerInputState.NoSignal, rig.session.fingers.read(System.nanoTime()).state)
    }

    @Test
    fun switchingGamesReleasesTheFingerPipelineBeforeTheNextOneOpens() {
        val fingersModels = twoHands()
        val faceModels = FakeHandModels()
        var fingersClosedWhenFaceOpened = false
        val rig = Rig(ArcadeTrackerSettings.FINGERS_DEFAULT) { s ->
            if (s.mode == ArcadeTrackerMode.Face) {
                fingersClosedWhenFaceOpened = fingersModels.closed
                faceModels
            } else {
                fingersModels
            }
        }
        rig.startReady()
        rig.sources[0].sink.onFrame(frame, 640, 480)
        waitUntil { fingersModels.palmCalls > 0 }
        rig.session.stop(ArcadeStopReason.ExitArcade)
        rig.session.updateSettings(ArcadeTrackerSettings.FACE_DEFAULT)
        rig.startReady()
        rig.sources[1].sink.onFrame(frame, 640, 480)
        waitUntil { faceModels.faceCalls > 0 }
        assertTrue(fingersClosedWhenFaceOpened, "only one native pipeline at a time")
        assertEquals(2, rig.sources.size)
        assertEquals(1, rig.sources[0].stops)
        rig.session.stop(ArcadeStopReason.ExitArcade)
        waitUntil { faceModels.closed }
        assertTrue(faceModels.closed)
    }

    @Test
    fun unavailableModelsSurfaceAsACameraFailureSoTouchFallbackApplies() {
        val rig = Rig(ArcadeTrackerSettings.FINGERS_DEFAULT, factory = null)
        rig.startReady()
        rig.sources[0].sink.onFrame(frame, 640, 480)
        waitUntil { rig.session.state() == CameraState.Unavailable }
        assertEquals(CameraState.Unavailable, rig.session.state())
        assertTrue(rig.session.failureReason()!!.startsWith("landmark tracker unavailable"))
        val game = FingerMathGame()
        val status = FingerMathText.status(game, rig.session.fingers.read(System.nanoTime()), rig.session.state())
        assertTrue(status.contains("TAP AN ANSWER"), status)
        rig.session.stop(ArcadeStopReason.ExitArcade)
    }
}
