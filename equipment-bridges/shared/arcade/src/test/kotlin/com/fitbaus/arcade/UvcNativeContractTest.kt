// SPDX-License-Identifier: AGPL-3.0-only
package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.atomic.AtomicInteger

class UvcNativeContractTest {
    private class ManualWorker : CameraWorker {
        val queue = ArrayDeque<() -> Unit>()
        override fun post(task: () -> Unit) {
            queue.addLast(task)
        }

        fun runAll() {
            while (true) {
                val task = queue.removeFirstOrNull() ?: return
                task()
            }
        }
    }

    private class FakeFd : AuthorizedCameraFd {
        var closed = 0
            private set
        override fun fileDescriptor(): Int = 42
        override fun close() {
            closed += 1
        }
    }

    private class FakeEngine(
        var failOpen: Boolean = false,
        var throwOnClose: Boolean = false,
    ) : UvcStreamEngine {
        var opens = 0
        var closes = 0
        var sink: UvcNative.Sink? = null

        override fun open(fileDescriptor: Int, sink: UvcNative.Sink): Long {
            opens += 1
            this.sink = sink
            return if (failOpen) 0L else 99L
        }

        override fun close(handle: Long) {
            closes += 1
            sink = null
            if (throwOnClose) throw RuntimeException("native close boom")
        }
    }

    private class RecordingListener : FrameSourceListener {
        val events = ArrayList<String>()
        override fun onCameraReady(width: Int, height: Int, frontFacing: Boolean) {
            events += "ready:$width:$height:$frontFacing"
        }

        override fun onCameraFailed(reason: String) {
            events += "failed:$reason"
        }
    }

    private class FakeConsumer : FrameConsumer {
        override var mirror: Boolean = true
        override val failure: String? = null
        val frames = AtomicInteger()
        override fun onFrame(nv21: ByteArray, width: Int, height: Int): Boolean {
            frames.incrementAndGet()
            return true
        }

        override fun close() = Unit
        override fun stats(): TrackerStats = TrackerStats(
            mode = ArcadeTrackerMode.Classical,
            processedFrames = 0L,
            processingP50Ms = Float.NaN,
            processingP90Ms = Float.NaN,
            inferenceP50Ms = Float.NaN,
            frameAgeP50Ms = Float.NaN,
            framesSuperseded = 0L,
            trackingLosses = 0,
            reacquisitions = 0,
            lastError = null,
        )
    }

    private class FakeCamera1 : FrameSource {
        var starts = 0
        var stops = 0
        override fun start(listener: FrameSourceListener) {
            starts += 1
            listener.onCameraReady(320, 240, true)
        }

        override fun stop() {
            stops += 1
        }
    }

    private fun firstIndex(trace: List<String>, prefix: String): Int =
        trace.indexOfFirst { it.startsWith(prefix) }

    @Test
    fun prefersExternalAndClosesNativeBeforeFd() {
        val worker = ManualWorker()
        val trace = ArrayList<String>()
        val fd = FakeFd()
        val engine = FakeEngine()
        val source = PreferExternalCameraFrameSource(
            worker = worker,
            sink = FakeConsumer(),
            external = { fd },
            uvcEngine = engine,
            camera1Factory = { error("camera1 should not open") },
            events = trace,
        )
        source.start(RecordingListener())
        worker.runAll()
        assertTrue(source.usedExternal)
        source.stop()
        worker.runAll()
        val native = firstIndex(trace, "nativeClose")
        val fdClose = firstIndex(trace, "fdClose")
        assertTrue(native >= 0 && fdClose >= 0 && native < fdClose, trace.toString())
        assertEquals(1, fd.closed)
        assertTrue(source.releaseComplete)
    }

    @Test
    fun nativeCloseFailureStillClosesFdAndWorkerContinues() {
        val worker = ManualWorker()
        val trace = ArrayList<String>()
        val fd = FakeFd()
        val engine = FakeEngine(throwOnClose = true)
        val camera1 = FakeCamera1()
        val source = PreferExternalCameraFrameSource(
            worker = worker,
            sink = FakeConsumer(),
            external = { fd },
            uvcEngine = engine,
            camera1Factory = { camera1 },
            events = trace,
        )
        source.start(RecordingListener())
        worker.runAll()
        source.stop()
        worker.runAll()
        assertTrue(firstIndex(trace, "nativeClose") < firstIndex(trace, "fdClose"), trace.toString())
        assertTrue(trace.any { it.startsWith("nativeCloseError:") }, trace.toString())
        assertEquals(1, fd.closed)
        val source2 = PreferExternalCameraFrameSource(
            worker = worker,
            sink = FakeConsumer(),
            external = { null },
            uvcEngine = engine,
            camera1Factory = { camera1 },
        )
        source2.start(RecordingListener())
        worker.runAll()
        assertEquals(1, camera1.starts)
    }

    @Test
    fun fallsBackToCamera1WhenExternalMissing() {
        val worker = ManualWorker()
        val camera1 = FakeCamera1()
        val source = PreferExternalCameraFrameSource(
            worker = worker,
            sink = FakeConsumer(),
            external = { null },
            uvcEngine = FakeEngine(),
            camera1Factory = { camera1 },
        )
        source.start(RecordingListener())
        worker.runAll()
        assertFalse(source.usedExternal)
        assertEquals(1, camera1.starts)
        source.stop()
        worker.runAll()
        assertEquals(1, camera1.stops)
    }

    @Test
    fun fallsBackWhenNativeOpenFailsAndReleasesFd() {
        val worker = ManualWorker()
        val trace = ArrayList<String>()
        val fd = FakeFd()
        val engine = FakeEngine(failOpen = true)
        val camera1 = FakeCamera1()
        val source = PreferExternalCameraFrameSource(
            worker = worker,
            sink = FakeConsumer(),
            external = { fd },
            uvcEngine = engine,
            camera1Factory = { camera1 },
            events = trace,
        )
        source.start(RecordingListener())
        worker.runAll()
        assertEquals(1, engine.opens)
        assertEquals(0, engine.closes)
        assertEquals(1, fd.closed)
        assertEquals(1, camera1.starts)
        assertFalse(source.usedExternal)
    }

    @Test
    fun stopDuringProviderOpenClosesFdWithoutNative() {
        val worker = ManualWorker()
        val fd = FakeFd()
        val engine = FakeEngine()
        lateinit var source: PreferExternalCameraFrameSource
        source = PreferExternalCameraFrameSource(
            worker = worker,
            sink = FakeConsumer(),
            external = {
                source.stop()
                fd
            },
            uvcEngine = engine,
            camera1Factory = { error("no camera1") },
        )
        source.start(RecordingListener())
        worker.runAll()
        assertEquals(0, engine.opens)
        assertEquals(1, fd.closed)
        assertTrue(source.releaseComplete)
    }

    @Test
    fun stopAfterNativeOpenClosesNativeBeforeFd() {
        val worker = ManualWorker()
        val trace = ArrayList<String>()
        val fd = FakeFd()
        val engine = FakeEngine()
        lateinit var source: PreferExternalCameraFrameSource
        source = PreferExternalCameraFrameSource(
            worker = worker,
            sink = FakeConsumer(),
            external = { fd },
            uvcEngine = object : UvcStreamEngine {
                override fun open(fileDescriptor: Int, sink: UvcNative.Sink): Long {
                    val handle = engine.open(fileDescriptor, sink)
                    source.stop()
                    return handle
                }

                override fun close(handle: Long) = engine.close(handle)
            },
            camera1Factory = { error("no") },
            events = trace,
        )
        source.start(RecordingListener())
        worker.runAll()
        assertEquals(1, engine.closes)
        assertTrue(firstIndex(trace, "nativeClose:stop-after-native") < firstIndex(trace, "fdClose:stop-after-native"), trace.toString())
        assertEquals(1, fd.closed)
    }

    @Test
    fun staleCallbacksIgnoredAfterStop() {
        val worker = ManualWorker()
        val engine = FakeEngine()
        val consumer = FakeConsumer()
        val source = PreferExternalCameraFrameSource(
            worker = worker,
            sink = consumer,
            external = { FakeFd() },
            uvcEngine = engine,
            camera1Factory = { error("no") },
        )
        source.start(RecordingListener())
        worker.runAll()
        val sink = engine.sink ?: error("missing sink")
        sink.onFrame(ByteArray(115_200), 320, 240)
        assertEquals(1, consumer.frames.get())
        source.stop()
        worker.runAll()
        sink.onFrame(ByteArray(115_200), 320, 240)
        assertEquals(1, consumer.frames.get())
    }

    @Test
    fun sessionsDoNotReleaseEachOthersResources() {
        val worker = ManualWorker()
        val fdA = FakeFd()
        val fdB = FakeFd()
        val engineA = FakeEngine()
        val engineB = FakeEngine()
        val a = PreferExternalCameraFrameSource(worker, FakeConsumer(), { fdA }, engineA, { error("no") })
        val b = PreferExternalCameraFrameSource(worker, FakeConsumer(), { fdB }, engineB, { error("no") })
        a.start(RecordingListener())
        worker.runAll()
        a.stop()
        b.start(RecordingListener())
        worker.runAll()
        assertEquals(1, engineA.closes)
        assertEquals(0, engineB.closes)
        assertEquals(1, fdA.closed)
        assertEquals(0, fdB.closed)
        b.stop()
        worker.runAll()
        assertEquals(1, engineB.closes)
        assertEquals(1, fdB.closed)
    }

    @Test
    fun rapidReentryUsesFreshSourceInstances() {
        val worker = ManualWorker()
        val camera1 = FakeCamera1()
        repeat(3) {
            val source = PreferExternalCameraFrameSource(
                worker = worker,
                sink = FakeConsumer(),
                external = { null },
                uvcEngine = FakeEngine(),
                camera1Factory = { camera1 },
            )
            source.start(RecordingListener())
            worker.runAll()
            source.stop()
            worker.runAll()
        }
        assertEquals(3, camera1.starts)
        assertEquals(3, camera1.stops)
    }
}
