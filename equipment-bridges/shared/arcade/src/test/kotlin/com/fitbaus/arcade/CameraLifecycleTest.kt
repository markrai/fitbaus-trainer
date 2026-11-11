// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import com.fitbaus.arcade.Nv21Frames.Blob
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

class CameraLifecycleTest {
    private class ManualWorker : CameraWorker {
        val queue = ArrayDeque<() -> Unit>()

        override fun post(task: () -> Unit) {
            queue.addLast(task)
        }

        fun runOne(): Boolean {
            val task = queue.removeFirstOrNull() ?: return false
            task()
            return true
        }

        fun runAll() {
            while (runOne()) Unit
        }
    }

    private class FakeCamera {
        var holder: FakeDriver? = null
        var opens = 0
        var releases = 0
        var busyFailures = 0
    }

    private class FakeDriver(val camera: FakeCamera, val failAfterOpen: Boolean = false) : CameraDriver {
        var onError: ((String) -> Unit)? = null
        var releaseCalls = 0

        override fun open(onError: (String) -> Unit): CameraOpenResult {
            this.onError = onError
            if (camera.holder != null) {
                camera.busyFailures += 1
                return CameraOpenResult.Failed("camera busy")
            }
            camera.holder = this
            camera.opens += 1
            return if (failAfterOpen) CameraOpenResult.Failed("NV21 preview unsupported") else CameraOpenResult.Opened(320, 240, true)
        }

        override fun release() {
            releaseCalls += 1
            if (camera.holder === this) {
                camera.holder = null
                camera.releases += 1
            }
        }
    }

    private class RecordingListener : FrameSourceListener {
        val events = ArrayList<String>()

        override fun onCameraReady(width: Int, height: Int, frontFacing: Boolean) {
            events += "ready"
        }

        override fun onCameraFailed(reason: String) {
            events += "failed:$reason"
        }
    }

    private class Rig {
        val worker = ManualWorker()
        val camera = FakeCamera()
        val input = HandPositionInput()
        val drivers = ArrayList<FakeDriver>()
        val sources = ArrayList<SerialCameraFrameSource>()
        val sinks = ArrayList<FrameConsumer>()
        val session = ArcadeCameraSession(FakePermission(granted = true), input) { sink ->
            sinks += sink
            val driver = FakeDriver(camera).also { drivers += it }
            SerialCameraFrameSource(worker, driver).also { sources += it }
        }
        val host = ArcadeToggle(session)
    }

    @Test
    fun stopReturnsImmediatelyAndReleaseCompletesOnWorker() {
        val worker = ManualWorker()
        val camera = FakeCamera()
        val source = SerialCameraFrameSource(worker, FakeDriver(camera))
        val listener = RecordingListener()
        source.start(listener)
        assertNull(camera.holder, "open runs on the worker, not the caller")
        worker.runAll()
        assertEquals(listOf("ready"), listener.events)
        assertNotNull(camera.holder)
        source.stop()
        assertFalse(source.releaseComplete, "stop does not wait for the release")
        assertNotNull(camera.holder)
        worker.runAll()
        assertTrue(source.releaseComplete)
        assertNull(camera.holder)
        assertEquals(1, camera.releases)
    }

    @Test
    fun stopBeforeOpenRunsSkipsOpenEntirely() {
        val worker = ManualWorker()
        val camera = FakeCamera()
        val source = SerialCameraFrameSource(worker, FakeDriver(camera))
        val listener = RecordingListener()
        source.start(listener)
        source.stop()
        worker.runAll()
        assertEquals(0, camera.opens)
        assertTrue(listener.events.isEmpty())
        assertTrue(source.releaseComplete)
    }

    @Test
    fun stopWithoutStartIsComplete() {
        val source = SerialCameraFrameSource(ManualWorker(), FakeDriver(FakeCamera()))
        source.stop()
        assertTrue(source.releaseComplete)
        source.start(RecordingListener())
        assertTrue(source.releaseComplete)
    }

    @Test
    fun newSessionOpensOnlyAfterPreviousReleaseCompletes() {
        val rig = Rig()
        rig.host.onHostResume()
        rig.host.select(true)
        rig.worker.runAll()
        assertEquals(CameraState.Ready, rig.session.state())
        rig.host.onHostPause()
        rig.host.onHostResume()
        assertEquals(2, rig.sources.size)
        assertFalse(rig.sources[0].releaseComplete)
        rig.worker.runOne()
        assertTrue(rig.sources[0].releaseComplete)
        assertNull(rig.camera.holder)
        rig.worker.runOne()
        assertTrue(rig.camera.holder === rig.drivers[1])
        assertEquals(0, rig.camera.busyFailures)
        assertEquals(CameraState.Ready, rig.session.state())
    }

    @Test
    fun rapidModeTogglesOpenOnlyTheFinalSession() {
        val rig = Rig()
        rig.host.onHostResume()
        repeat(25) { rig.host.toggle() }
        assertTrue(rig.host.arcade)
        assertEquals(0, rig.camera.opens, "nothing opened on the caller thread")
        rig.worker.runAll()
        assertEquals(0, rig.camera.busyFailures)
        assertEquals(1, rig.camera.opens, "cancelled sessions never open the camera")
        assertTrue(rig.camera.holder === rig.drivers.last())
        assertTrue(rig.sources.dropLast(1).all { it.releaseComplete })
        assertEquals(CameraState.Ready, rig.session.state())
        rig.host.toggle()
        rig.worker.runAll()
        assertNull(rig.camera.holder)
        assertTrue(rig.sources.all { it.releaseComplete })
    }

    @Test
    fun randomTogglesPausesAndWorkerProgressNeverDoubleOpen() {
        val random = Random(20261110)
        repeat(20) {
            val rig = Rig()
            rig.host.onHostResume()
            var resumed = true
            repeat(400) {
                when (random.nextInt(6)) {
                    0, 1 -> rig.host.toggle()
                    2 -> if (resumed) {
                        rig.host.onHostPause()
                        resumed = false
                    } else {
                        rig.host.onHostResume()
                        resumed = true
                    }
                    3, 4 -> rig.worker.runOne()
                    else -> rig.worker.runAll()
                }
                assertEquals(0, rig.camera.busyFailures)
            }
            rig.worker.runAll()
            assertEquals(0, rig.camera.busyFailures)
            if (rig.host.isActive) {
                assertTrue(rig.camera.holder === rig.drivers.last())
                assertEquals(CameraState.Ready, rig.session.state())
            } else {
                assertNull(rig.camera.holder)
                assertTrue(rig.sources.all { it.releaseComplete })
            }
        }
    }

    @Test
    fun delayedCallbacksAfterStopAreIgnored() {
        val rig = Rig()
        rig.host.onHostResume()
        rig.host.select(true)
        rig.worker.runAll()
        val oldDriver = rig.drivers[0]
        val oldSink = rig.sinks[0]
        rig.host.select(false)
        oldDriver.onError!!.invoke("late camera error")
        assertEquals(CameraState.Off, rig.session.state())
        val frame = Nv21Frames.allocate(320, 240)
        for (i in 0 until 10) oldSink.onFrame(Nv21Frames.paint(frame, 320, 240, Blob(40 + 8 * i, 120, 48)), 320, 240)
        assertFalse(rig.input.cameraTracking(System.nanoTime()), "late frames from the stopped session are dropped")
        rig.worker.runAll()
        assertNull(rig.camera.holder)
        assertTrue(rig.sources[0].releaseComplete)
    }

    @Test
    fun runtimeErrorReleasesCameraAndReportsUnavailable() {
        val rig = Rig()
        rig.host.onHostResume()
        rig.host.select(true)
        rig.worker.runAll()
        rig.drivers[0].onError!!.invoke("camera error 100")
        assertNull(rig.camera.holder)
        assertEquals(CameraState.Unavailable, rig.session.state())
        assertEquals("camera error 100", rig.session.failureReason())
        rig.host.select(false)
        rig.worker.runAll()
        assertEquals(CameraState.Off, rig.session.state())
        assertTrue(rig.sources[0].releaseComplete)
    }

    @Test
    fun failedOpenReleasesPartiallyOpenedCamera() {
        val worker = ManualWorker()
        val camera = FakeCamera()
        val driver = FakeDriver(camera, failAfterOpen = true)
        val source = SerialCameraFrameSource(worker, driver)
        val listener = RecordingListener()
        source.start(listener)
        worker.runAll()
        assertEquals(listOf("failed:NV21 preview unsupported"), listener.events)
        assertNull(camera.holder)
        assertEquals(1, driver.releaseCalls)
    }
}
