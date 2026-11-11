// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ArcadeCameraSessionTest {
    private class Rig(granted: Boolean, requestable: Boolean = true) {
        val input = HandPositionInput()
        val permission = FakePermission(granted, requestable)
        val sources = ArrayList<FakeFrameSource>()
        val session = ArcadeCameraSession(permission, input) { sink -> FakeFrameSource(sink).also { sources += it } }
    }

    @Test
    fun grantedPermissionStartsCameraAndReportsReady() {
        val rig = Rig(granted = true)
        rig.session.start()
        assertEquals(CameraState.Starting, rig.session.state())
        assertEquals(1, rig.sources.size)
        assertNull(rig.session.info())
        rig.sources[0].listener!!.onCameraReady(320, 240, true)
        assertEquals(CameraState.Ready, rig.session.state())
        val info = requireNotNull(rig.session.info())
        assertEquals(320, info.width)
        assertTrue(info.frontFacing)
        assertEquals(0, rig.permission.requests)
    }

    @Test
    fun startIsIdempotentWhileRunning() {
        val rig = Rig(granted = true)
        rig.session.start()
        rig.session.start()
        assertEquals(1, rig.sources.size)
    }

    @Test
    fun runtimePermissionRequestedOnceAndHonouredOnGrant() {
        val rig = Rig(granted = false)
        rig.session.start()
        assertEquals(CameraState.Requesting, rig.session.state())
        assertEquals(1, rig.permission.requests)
        // The permission dialog pauses and resumes the activity before/after the result.
        rig.session.stop(ArcadeStopReason.HostPaused)
        rig.session.start()
        assertEquals(1, rig.permission.requests, "no duplicate request while one is pending")
        rig.permission.granted = true
        rig.session.onPermissionResult(true)
        assertEquals(CameraState.Starting, rig.session.state())
        assertEquals(1, rig.sources.size)
    }

    @Test
    fun denialDegradesToTouchOnlyAndIsStickyAcrossPauseButNotExit() {
        val rig = Rig(granted = false)
        rig.session.start()
        rig.session.onPermissionResult(false)
        assertEquals(CameraState.PermissionDenied, rig.session.state())
        assertEquals(ArcadeStatus.PermissionDenied, ArcadeStatusResolver.resolve(rig.session.state(), false, false))
        rig.session.stop(ArcadeStopReason.HostPaused)
        rig.session.start()
        assertEquals(CameraState.PermissionDenied, rig.session.state())
        assertEquals(1, rig.permission.requests, "no request loop after denial")
        rig.session.stop(ArcadeStopReason.ExitArcade)
        assertEquals(CameraState.Off, rig.session.state())
        rig.session.start()
        assertEquals(2, rig.permission.requests, "re-entering Arcade may ask again")
        assertTrue(rig.sources.isEmpty())
    }

    @Test
    fun permissionResultAfterLeavingDoesNotOpenCamera() {
        val rig = Rig(granted = false)
        rig.session.start()
        rig.session.stop(ArcadeStopReason.ExitArcade)
        rig.session.onPermissionResult(true)
        assertTrue(rig.sources.isEmpty())
        assertEquals(CameraState.Off, rig.session.state())
    }

    @Test
    fun noRuntimeRequestPossibleMeansDenied() {
        val rig = Rig(granted = false, requestable = false)
        rig.session.start()
        assertEquals(CameraState.PermissionDenied, rig.session.state())
        assertEquals(0, rig.permission.requests)
    }

    @Test
    fun cameraFailureIsUnavailableUntilStopped() {
        val rig = Rig(granted = true)
        rig.session.start()
        rig.sources[0].listener!!.onCameraFailed("no camera")
        assertEquals(CameraState.Unavailable, rig.session.state())
        assertEquals("no camera", rig.session.failureReason())
        assertEquals(ArcadeStatus.Unavailable, ArcadeStatusResolver.resolve(rig.session.state(), false, false))
        rig.session.stop(ArcadeStopReason.HostPaused)
        assertEquals(1, rig.sources[0].stops)
        assertEquals(CameraState.Off, rig.session.state())
        assertNull(rig.session.failureReason())
    }

    @Test
    fun stopReleasesCameraAndClearsTracking() {
        val rig = Rig(granted = true)
        rig.session.start()
        val source = rig.sources[0]
        source.listener!!.onCameraReady(320, 240, true)
        rig.input.publishCamera(0.4f, 0.5f, 1f, System.nanoTime(), rig.input.cameraGeneration())
        assertTrue(rig.input.cameraTracking(System.nanoTime()))
        rig.session.stop(ArcadeStopReason.ExitArcade)
        assertEquals(1, source.stops)
        assertFalse(rig.input.cameraTracking(System.nanoTime()))
        assertNull(rig.session.info())
    }

    @Test
    fun lateCallbacksFromReleasedSourceAreIgnored() {
        val rig = Rig(granted = true)
        rig.session.start()
        val old = rig.sources[0]
        rig.session.stop(ArcadeStopReason.HostPaused)
        rig.session.start()
        old.listener!!.onCameraFailed("late error")
        assertEquals(CameraState.Starting, rig.session.state())
        old.listener!!.onCameraReady(320, 240, true)
        assertEquals(CameraState.Starting, rig.session.state())
        rig.sources[1].listener!!.onCameraReady(320, 240, false)
        assertEquals(CameraState.Ready, rig.session.state())
    }

    @Test
    fun eachStartUsesFreshTrackerState() {
        val rig = Rig(granted = true)
        rig.session.start()
        val firstSink = rig.sources[0].sink
        rig.session.stop(ArcadeStopReason.ExitArcade)
        rig.session.start()
        assertTrue(rig.sources[1].sink !== firstSink)
    }

    @Test
    fun modeSwitchingStartsAndReleasesCameraSession() {
        val input = HandPositionInput()
        val permission = FakePermission(granted = true)
        val sources = ArrayList<FakeFrameSource>()
        val session = ArcadeCameraSession(permission, input) { sink -> FakeFrameSource(sink).also { sources += it } }
        val controller = ArcadeToggle(session)

        controller.onHostResume()
        controller.select(true)
        assertEquals(1, sources.size)
        assertEquals(1, sources[0].starts)
        sources[0].listener!!.onCameraReady(320, 240, true)
        assertEquals(CameraState.Ready, session.state())

        controller.onHostPause()
        assertEquals(1, sources[0].stops)
        assertEquals(CameraState.Off, session.state())
        controller.onHostResume()
        assertEquals(2, sources.size)
        assertEquals(1, sources[1].starts)

        controller.select(false)
        assertEquals(1, sources[1].stops, "returning to Dashboard releases camera")
        assertEquals(CameraState.Off, session.state())

        repeat(5) { controller.toggle() }
        assertEquals(CameraState.Starting, session.state())
        assertTrue(sources.dropLast(1).all { it.starts == 1 && it.stops == 1 })
        assertEquals(0, sources.last().stops)
    }

    @Test
    fun previewSizePolicy() {
        val sizes = listOf(PreviewSize(1280, 720), PreviewSize(640, 480), PreviewSize(320, 240), PreviewSize(176, 144))
        assertEquals(PreviewSize(320, 240), CameraPreviewPolicy.choose(sizes))
        assertEquals(PreviewSize(640, 480), CameraPreviewPolicy.choose(listOf(PreviewSize(1280, 720), PreviewSize(640, 480))))
        assertEquals(PreviewSize(640, 480), CameraPreviewPolicy.choose(listOf(PreviewSize(640, 360), PreviewSize(640, 480))))
        assertEquals(PreviewSize(176, 144), CameraPreviewPolicy.choose(listOf(PreviewSize(176, 144), PreviewSize(160, 120))))
        assertNull(CameraPreviewPolicy.choose(emptyList()))
        assertEquals(115_200, CameraPreviewPolicy.nv21BufferSize(320, 240))
    }
}
