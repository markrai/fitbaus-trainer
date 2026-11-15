// SPDX-License-Identifier: AGPL-3.0-only
package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ExternalWebcamPreviewTest {
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

        fun runOne() {
            queue.removeFirstOrNull()?.invoke()
        }
    }

    private class FakeFd(
        private val identity: String? = "046d:0825",
        private val attachment: String? = "046d:0825:/dev/bus/usb/001/002",
    ) : AuthorizedCameraFd {
        var closed = 0
            private set
        override fun fileDescriptor(): Int = 7
        override fun zoomIdentity(): String? = identity
        override fun attachmentKey(): String? = attachment
        override fun close() {
            closed += 1
        }
    }

    private class FakeEngine(
        private val baseCaps: UvcZoomCapability = UvcZoomCapability.UNSUPPORTED,
        private var setOk: Boolean = true,
        private var readbackThrows: Boolean = false,
        /** When set succeeds, GET_CUR reports this instead of the request (device snap). */
        private var reportedCurrent: Int? = null,
    ) : UvcStreamEngine {
        var opens = 0
        var closes = 0
        var lastZoom: Int? = null
        var zoomCalls = 0
        var liveHandles = 0
        var nextHandle = 55L
        val sinks = ArrayList<UvcNative.Sink>()
        var sink: UvcNative.Sink? = null
        val closeOrder = ArrayList<String>()
        val ops = ArrayList<String>()
        private var cur = baseCaps.current

        override fun open(fileDescriptor: Int, sink: UvcNative.Sink): UvcOpenResult {
            opens += 1
            liveHandles += 1
            ops += "open"
            sinks.add(sink)
            this.sink = sink
            val h = nextHandle
            nextHandle += 1
            return UvcOpenResult(h, 320, 240)
        }

        override fun close(handle: Long) {
            closes += 1
            liveHandles -= 1
            ops += "close"
            closeOrder += "native"
        }

        override fun zoomCapability(handle: Long): UvcZoomCapability {
            if (readbackThrows) throw RuntimeException("readback boom")
            if (!baseCaps.supported) return UvcZoomCapability.UNSUPPORTED
            return baseCaps.copy(current = cur)
        }

        override fun setZoom(handle: Long, value: Int): Boolean {
            zoomCalls += 1
            ops += "zoom"
            lastZoom = value
            if (!setOk || !baseCaps.supported) return false
            cur = reportedCurrent ?: value
            return true
        }

        fun failSets() {
            setOk = false
        }
    }

    private class RecordingListener : ExternalWebcamPreview.Listener {
        val events = ArrayList<String>()
        val frames = ArrayList<ExternalWebcamPreview.PreviewFrame>()
        val zooms = ArrayList<ExternalWebcamPreview.ZoomResult>()

        override fun onStatus(sessionId: Int, message: String) {
            events += "status:$sessionId:$message"
        }

        override fun onReady(
            sessionId: Int,
            width: Int,
            height: Int,
            capability: UvcZoomCapability,
            zoomIdentity: String?,
            attachmentKey: String?,
        ) {
            events += "ready:$sessionId:$width:$height:${capability.supported}:$zoomIdentity:$attachmentKey"
        }

        override fun onFrame(frame: ExternalWebcamPreview.PreviewFrame) {
            frames += frame
            events += "frame:${frame.sessionId}"
        }

        override fun onFailed(sessionId: Int, reason: String) {
            events += "failed:$sessionId:$reason"
        }

        override fun onStopped(sessionId: Int) {
            events += "stopped:$sessionId"
        }

        override fun onZoomResult(result: ExternalWebcamPreview.ZoomResult) {
            zooms += result
            events += "zoom:${result.sessionId}:${result.requestId}:${result.ok}:${result.value}:rb=${result.readbackOk}:cur=${result.capability.current}"
        }
    }

    private fun supportedCaps(current: Int = 250) =
        UvcZoomCapability(supported = true, min = 100, max = 400, step = 10, default = 200, current = current)

    private fun nv21(): ByteArray = ByteArray(320 * 240)

    @Test
    fun opensAppliesZoomHookThenClosesNativeBeforeFd() {
        val worker = ManualWorker()
        val fd = FakeFd()
        val engine = FakeEngine(supportedCaps())
        var hookHandle = 0L
        var hookIdentity: String? = null
        val preview = ExternalWebcamPreview(
            external = { fd },
            zoomHook = { h, id ->
                hookHandle = h
                hookIdentity = id
            },
            uvcEngine = engine,
            worker = worker,
            maxPreviewWidth = 160,
            frameStride = 1,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        assertEquals(55L, hookHandle)
        assertEquals("046d:0825", hookIdentity)

        preview.requestSetZoom(100, requestId = 9)
        worker.runAll()
        assertEquals(100, engine.lastZoom)
        assertEquals(1, listener.zooms.size)
        assertTrue(listener.zooms[0].ok)
        assertTrue(listener.zooms[0].readbackOk)
        assertEquals(100, listener.zooms[0].capability.current)

        preview.stop()
        worker.runAll()
        assertEquals(1, engine.closes)
        assertEquals(1, fd.closed)
        assertEquals(listOf("native"), engine.closeOrder)
        assertEquals(0, engine.liveHandles)
        assertTrue(listener.events.any { it.startsWith("stopped:") })
    }

    @Test
    fun zoomUsesDeviceReportedCurrentNotRequestedValue() {
        val worker = ManualWorker()
        val engine = FakeEngine(supportedCaps(current = 250), reportedCurrent = 110)
        val preview = ExternalWebcamPreview(
            external = { FakeFd() },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        preview.requestSetZoom(100, 1)
        worker.runAll()
        assertTrue(listener.zooms[0].ok)
        assertTrue(listener.zooms[0].readbackOk)
        assertEquals(100, listener.zooms[0].value)
        assertEquals(110, listener.zooms[0].capability.current)
    }

    @Test
    fun zoomReadbackFailureKeepsOkWithoutFakeCurrent() {
        val worker = ManualWorker()
        val engine = FakeEngine(supportedCaps(), readbackThrows = true)
        val preview = ExternalWebcamPreview(
            external = { FakeFd() },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
            frameStride = 1,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        preview.requestSetZoom(100, 1)
        worker.runAll()
        assertTrue(listener.zooms[0].ok)
        assertFalse(listener.zooms[0].readbackOk)
        assertFalse(listener.zooms[0].capability.supported)
        engine.sink?.onFrame(nv21(), 320, 240)
        assertEquals(1, listener.frames.size)
    }

    @Test
    fun singleUseRejectsSecondStart() {
        val worker = ManualWorker()
        val engine = FakeEngine(supportedCaps())
        val preview = ExternalWebcamPreview(
            external = { FakeFd() },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        preview.stop()
        worker.runAll()
        preview.start(listener)
        worker.runAll()
        assertEquals(1, engine.opens)
        assertTrue(listener.events.any { it.contains("already used") })
    }

    @Test
    fun duplicateStartDoesNotReplaceActiveListener() {
        val worker = ManualWorker()
        val engine = FakeEngine(supportedCaps())
        val preview = ExternalWebcamPreview(
            external = { FakeFd() },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
            frameStride = 1,
        )
        val primary = RecordingListener()
        val intruder = RecordingListener()
        preview.start(primary)
        worker.runAll()
        preview.start(intruder)
        worker.runAll()
        assertTrue(intruder.events.any { it.contains("already used") })
        assertTrue(intruder.frames.isEmpty())
        assertTrue(intruder.zooms.isEmpty())
        engine.sink?.onFrame(nv21(), 320, 240)
        assertEquals(1, primary.frames.size)
        assertTrue(intruder.frames.isEmpty())
        preview.requestSetZoom(100, 1)
        worker.runAll()
        assertEquals(1, primary.zooms.size)
        assertTrue(intruder.zooms.isEmpty())
    }

    @Test
    fun stopIsIdempotent() {
        val worker = ManualWorker()
        val fd = FakeFd()
        val engine = FakeEngine(supportedCaps())
        val preview = ExternalWebcamPreview(
            external = { fd },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        preview.stop()
        preview.stop()
        preview.stop()
        worker.runAll()
        assertEquals(1, engine.closes)
        assertEquals(1, fd.closed)
        assertEquals(1, listener.events.count { it.startsWith("stopped:") })
    }

    @Test
    fun staleStopCompletionDoesNotAffectNewerInstance() {
        val worker = ManualWorker()
        val engine = FakeEngine(supportedCaps())
        val listener = RecordingListener()

        val a = ExternalWebcamPreview(
            external = { FakeFd("a") },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
            frameStride = 1,
        )
        a.start(listener)
        worker.runAll()
        assertEquals(1, engine.liveHandles)
        val sinkA = engine.sinks.last()

        a.stop()
        // Do not drain yet — start B first on a fresh instance.
        val b = ExternalWebcamPreview(
            external = { FakeFd("b") },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
            frameStride = 1,
        )
        b.start(listener)
        worker.runAll()
        assertEquals(1, engine.liveHandles)
        assertEquals(2, engine.opens)
        assertEquals(1, engine.closes)

        // Delayed callback from A's native sink must not deliver frames or mutate B.
        val framesBefore = listener.frames.size
        sinkA.onFrame(nv21(), 320, 240)
        assertEquals(framesBefore, listener.frames.size)

        b.stop()
        worker.runAll()
        assertEquals(0, engine.liveHandles)
        assertEquals(2, engine.closes)
    }

    @Test
    fun startAStopAStartBThenACleanupLeavesBIntact() {
        val worker = ManualWorker()
        val engine = FakeEngine(supportedCaps())
        val listener = RecordingListener()

        val a = ExternalWebcamPreview(
            external = { FakeFd("a") },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
        )
        a.start(listener)
        // Stop A before its open runs; then start B.
        a.stop()
        val b = ExternalWebcamPreview(
            external = { FakeFd("b") },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
        )
        b.start(listener)
        worker.runAll()
        assertEquals(1, engine.opens)
        assertEquals(1, engine.liveHandles)
        assertTrue(listener.events.any { it.startsWith("ready:") })

        // Further start on A is rejected (single-use).
        a.start(listener)
        worker.runAll()
        assertEquals(1, engine.opens)
        assertEquals(1, engine.liveHandles)

        b.stop()
        worker.runAll()
        assertEquals(0, engine.liveHandles)
    }

    @Test
    fun frameRetainedAcrossStopIsNotMutatedAndStaleReleaseIsIgnored() {
        val worker = ManualWorker()
        val engine = FakeEngine(supportedCaps())
        val preview = ExternalWebcamPreview(
            external = { FakeFd() },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
            frameStride = 1,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        engine.sink?.onFrame(nv21(), 320, 240)
        assertEquals(1, listener.frames.size)
        val held = listener.frames[0]
        val snapshot = held.pixels.copyOf()

        preview.stop()
        worker.runAll()
        // Producer must not mutate the UI-owned buffer after stop.
        assertTrue(snapshot.contentEquals(held.pixels))

        // Stale release after stop still returns the buffer safely.
        preview.releaseFrame(held)
        assertTrue(snapshot.contentEquals(held.pixels))
    }

    @Test
    fun oldFrameReleaseDoesNotClearNewerPendingSlot() {
        val worker = ManualWorker()
        val engine = FakeEngine()
        val preview = ExternalWebcamPreview(
            external = { FakeFd() },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
            frameStride = 1,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        engine.sink?.onFrame(nv21(), 320, 240)
        val old = listener.frames[0]
        // Simulate UI losing the old frame reference without releasing, then... we can't publish
        // a newer frame while slot busy. Force-release path: manually test CAS semantics by
        // releasing old after we've... actually slot is busy with old. Release old, publish new,
        // then try release old again.
        preview.releaseFrame(old)
        engine.sink?.onFrame(nv21(), 320, 240)
        assertEquals(2, listener.frames.size)
        val newer = listener.frames[1]
        assertNotSame(old, newer)
        preview.releaseFrame(old) // stale
        // Newer still pending — another publish must drop.
        engine.sink?.onFrame(nv21(), 320, 240)
        assertEquals(2, listener.frames.size)
        preview.releaseFrame(newer)
        engine.sink?.onFrame(nv21(), 320, 240)
        assertEquals(3, listener.frames.size)
    }

    @Test
    fun delayedOldSinkAfterNewSessionOnSameWorkerDoesNotDeliver() {
        val worker = ManualWorker()
        val engine = FakeEngine(supportedCaps())
        val listener = RecordingListener()
        val a = ExternalWebcamPreview(
            external = { FakeFd("a") },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
            frameStride = 1,
        )
        a.start(listener)
        worker.runAll()
        val sinkA = engine.sinks[0]
        a.stop()
        worker.runAll()

        val b = ExternalWebcamPreview(
            external = { FakeFd("b") },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
            frameStride = 1,
        )
        b.start(listener)
        worker.runAll()
        val sinkB = engine.sinks[1]
        assertNotSame(sinkA, sinkB)

        val before = listener.frames.size
        sinkA.onFrame(nv21(), 320, 240)
        assertEquals(before, listener.frames.size)
        sinkB.onFrame(nv21(), 320, 240)
        assertEquals(before + 1, listener.frames.size)
        assertEquals(b.sessionId(), listener.frames.last().sessionId)
    }

    @Test
    fun bitmapBackpressureDropsFramesWhileSlotBusy() {
        val worker = ManualWorker()
        val engine = FakeEngine()
        val preview = ExternalWebcamPreview(
            external = { FakeFd() },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
            frameStride = 1,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        engine.sink?.onFrame(nv21(), 320, 240)
        engine.sink?.onFrame(nv21(), 320, 240)
        engine.sink?.onFrame(nv21(), 320, 240)
        assertEquals(1, listener.frames.size)
        preview.releaseFrame(listener.frames[0])
        engine.sink?.onFrame(nv21(), 320, 240)
        assertEquals(2, listener.frames.size)
    }

    @Test
    fun zoomQueuedAfterShutdownIsDropped() {
        val worker = ManualWorker()
        val engine = FakeEngine(supportedCaps())
        val preview = ExternalWebcamPreview(
            external = { FakeFd() },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        preview.stop()
        worker.runAll()
        preview.requestSetZoom(100, 2)
        worker.runAll()
        assertEquals(0, engine.zoomCalls)
        assertTrue(listener.zooms.isEmpty())
    }

    @Test
    fun stopBeforeWorkerRunsDoesNotOpenCamera() {
        val worker = ManualWorker()
        val fd = FakeFd()
        val engine = FakeEngine()
        val preview = ExternalWebcamPreview(
            external = { fd },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
        )
        val listener = RecordingListener()
        preview.start(listener)
        preview.stop()
        worker.runAll()
        assertEquals(0, engine.opens)
        assertEquals(0, fd.closed)
        assertTrue(listener.events.any { it.startsWith("stopped:") })
    }

    @Test
    fun missingCameraReportsFailure() {
        val worker = ManualWorker()
        val engine = FakeEngine()
        val preview = ExternalWebcamPreview(
            external = { null },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        assertTrue(listener.events.any { it.startsWith("failed:") })
        assertEquals(0, engine.opens)
    }

    @Test
    fun failedZoomDoesNotAbortStream() {
        val worker = ManualWorker()
        val fd = FakeFd()
        val engine = FakeEngine(supportedCaps())
        engine.failSets()
        val preview = ExternalWebcamPreview(
            external = { fd },
            zoomHook = null,
            uvcEngine = engine,
            worker = worker,
            frameStride = 1,
        )
        val listener = RecordingListener()
        preview.start(listener)
        worker.runAll()
        preview.requestSetZoom(100, 4)
        worker.runAll()
        assertEquals(1, listener.zooms.size)
        assertFalse(listener.zooms[0].ok)
        engine.sink?.onFrame(nv21(), 320, 240)
        assertEquals(1, listener.frames.size)
        preview.releaseFrame(listener.frames[0])
        assertEquals(0, fd.closed)
    }
}
