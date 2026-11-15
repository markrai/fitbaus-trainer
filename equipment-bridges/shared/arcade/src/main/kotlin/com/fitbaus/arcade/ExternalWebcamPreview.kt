// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Lightweight UVC-only preview for settings. Shares [ArcadeCameraThread] with arcade so open/close
 * and zoom control never race a game session. Does not run face/hand ML.
 *
 * Single-use lifecycle (matches [PairingActivity], which constructs a new instance per preview):
 * - [start] may be invoked once; later starts are rejected.
 * - [stop] is idempotent and posts cleanup on [worker].
 * - Stale stop/open/zoom worker tasks are discarded via [sessionId] checks.
 * - Native handle and USB FD are touched only on [worker]; native close precedes FD close.
 *
 * Caller serialization: [start] and [stop] assume serialized lifecycle callers (as with
 * [android.app.Activity] main-thread usage). Concurrent [start]/[stop] from multiple threads would
 * need additional synchronization beyond the existing claim atomics.
 *
 * Frame handoff:
 * - At most one pending [PreviewFrame]; further frames are dropped while the slot is busy.
 * - The pixel buffer is not reused until the owning frame is released via [releaseFrame].
 * - A stale [releaseFrame] that does not own the pending slot is a no-op.
 * - Stop does not reclaim a buffer still held by the UI; the UI must [releaseFrame].
 */
public class ExternalWebcamPreview internal constructor(
    private val external: ExternalCameraProvider,
    private val zoomHook: UvcZoomHook?,
    private val uvcEngine: UvcStreamEngine,
    private val worker: CameraWorker,
    private val maxPreviewWidth: Int = 320,
    private val frameStride: Int = 3,
) {
    public constructor(
        external: ExternalCameraProvider,
        zoomHook: UvcZoomHook? = null,
    ) : this(
        external,
        zoomHook,
        UvcStreamEngine.DEFAULT,
        ArcadeCameraThread,
    )

    public data class ZoomResult(
        public val sessionId: Int,
        public val requestId: Int,
        /** True when [uvcEngine.setZoom] succeeded. */
        public val ok: Boolean,
        /** Requested absolute zoom value. */
        public val value: Int,
        /**
         * Device-reported capability after the set attempt.
         * When [readbackOk] is true, [UvcZoomCapability.current] is GET_CUR from the device.
         */
        public val capability: UvcZoomCapability,
        /** True when a post-set capability query succeeded. */
        public val readbackOk: Boolean,
    )

    public data class PreviewFrame(
        public val sessionId: Int,
        public val pixels: IntArray,
        public val width: Int,
        public val height: Int,
    )

    public interface Listener {
        fun onStatus(sessionId: Int, message: String)
        fun onReady(
            sessionId: Int,
            width: Int,
            height: Int,
            capability: UvcZoomCapability,
            zoomIdentity: String?,
            attachmentKey: String?,
        )
        fun onFrame(frame: PreviewFrame)
        fun onFailed(sessionId: Int, reason: String)
        fun onStopped(sessionId: Int)
        fun onZoomResult(result: ZoomResult)
    }

    private val startClaimed = AtomicBoolean(false)
    private val stopPosted = AtomicBoolean(false)
    private val stopRequested = AtomicBoolean(false)
    private val generation = AtomicInteger(0)
    private val frameSlotBusy = AtomicBoolean(false)
    private val pendingFrame = AtomicReference<PreviewFrame?>(null)

    /** Touched only on [worker]. */
    private var handle: Long = 0L
    private var handleGen: Int = 0
    private var fd: AuthorizedCameraFd? = null
    private var openedIdentity: String? = null
    private var openedAttachmentKey: String? = null

    @Volatile
    private var listener: Listener? = null

    private var frameCounter = 0
    private var freeArgb: IntArray? = null

    public fun sessionId(): Int = generation.get()

    public fun start(listener: Listener) {
        // Reject before replacing the active listener so a duplicate start cannot steal callbacks.
        if (startClaimed.get() || stopPosted.get()) {
            listener.onStatus(generation.get(), "Preview already used")
            return
        }
        if (!startClaimed.compareAndSet(false, true)) {
            listener.onStatus(generation.get(), "Preview already used")
            return
        }
        if (stopPosted.get()) {
            listener.onStatus(generation.get(), "Preview already used")
            return
        }
        this.listener = listener
        stopRequested.set(false)
        val gen = generation.incrementAndGet()
        listener.onStatus(gen, "Opening webcam…")
        worker.post {
            if (!isLive(gen)) {
                finishStop(gen)
                return@post
            }
            openOnWorker(gen)
        }
    }

    public fun stop() {
        stopRequested.set(true)
        if (!stopPosted.compareAndSet(false, true)) return
        val stopGen = generation.incrementAndGet()
        worker.post {
            releaseOwned(upToGen = stopGen)
            finishStop(stopGen)
        }
    }

    /**
     * Queues an absolute zoom set on the camera worker. Never blocks the caller on USB I/O.
     * Results arrive via [Listener.onZoomResult] with the originating session/request ids.
     */
    public fun requestSetZoom(value: Int, requestId: Int) {
        val gen = generation.get()
        worker.post {
            if (!isLive(gen) || handle == 0L || handleGen != gen) return@post
            val h = handle
            val ok = try {
                uvcEngine.setZoom(h, value)
            } catch (t: Throwable) {
                Log.e(TAG, "setZoom failed", t)
                false
            }
            if (!isLive(gen) || handle != h || handleGen != gen) return@post
            var readbackOk = false
            val caps = try {
                // Prefer device GET_CUR from the query; never overwrite current with the request.
                uvcEngine.zoomCapability(h).also { readbackOk = true }
            } catch (t: Throwable) {
                Log.e(TAG, "zoomCapability after set failed", t)
                UvcZoomCapability.UNSUPPORTED
            }
            if (!isLive(gen) || handle != h || handleGen != gen) return@post
            val target = listener ?: return@post
            runCatching {
                target.onZoomResult(ZoomResult(gen, requestId, ok, value, caps, readbackOk))
            }
        }
    }

    /**
     * Releases a frame previously delivered to [Listener.onFrame].
     * Only the owning pending frame clears the slot; stale releases are ignored.
     */
    public fun releaseFrame(frame: PreviewFrame) {
        if (!pendingFrame.compareAndSet(frame, null)) return
        freeArgb = frame.pixels
        frameSlotBusy.set(false)
    }

    private fun isLive(gen: Int): Boolean =
        !stopRequested.get() && gen == generation.get()

    private fun openOnWorker(gen: Int) {
        val providerFd = try {
            external.openAuthorizedCamera()
        } catch (t: Throwable) {
            Log.e(TAG, "openAuthorizedCamera failed", t)
            null
        }
        if (providerFd == null) {
            notifyFailed(gen, "No authorized external webcam")
            finishStop(gen)
            return
        }
        if (!isLive(gen)) {
            closeFd(providerFd)
            finishStop(gen)
            return
        }

        val sink = object : UvcNative.Sink {
            override fun onFrame(nv21: ByteArray, width: Int, height: Int) {
                if (!isLive(gen)) return
                publishFrame(nv21, width, height, gen)
            }
        }

        val opened = try {
            uvcEngine.open(providerFd.fileDescriptor(), sink)
        } catch (t: Throwable) {
            Log.e(TAG, "native open failed", t)
            closeFd(providerFd)
            notifyFailed(gen, t.message ?: "UVC open failed")
            finishStop(gen)
            return
        }

        if (opened.handle == 0L || opened.width <= 0 || opened.height <= 0) {
            if (opened.handle != 0L) {
                try {
                    uvcEngine.close(opened.handle)
                } catch (_: Throwable) {
                }
            }
            closeFd(providerFd)
            notifyFailed(gen, "UVC open failed")
            finishStop(gen)
            return
        }

        if (!isLive(gen)) {
            closeNativeThenFd(opened.handle, providerFd)
            finishStop(gen)
            return
        }

        handle = opened.handle
        handleGen = gen
        fd = providerFd
        openedIdentity = providerFd.zoomIdentity()
        openedAttachmentKey = providerFd.attachmentKey()
        try {
            zoomHook?.onOpened(opened.handle, openedIdentity)
        } catch (t: Throwable) {
            Log.e(TAG, "zoom apply failed; continuing preview", t)
        }
        if (!isLive(gen) || handle != opened.handle || handleGen != gen) return
        val caps = try {
            uvcEngine.zoomCapability(opened.handle)
        } catch (_: Throwable) {
            UvcZoomCapability.UNSUPPORTED
        }
        if (!isLive(gen) || handle != opened.handle || handleGen != gen) return
        val target = listener
        if (target != null) {
            runCatching {
                target.onReady(
                    gen,
                    opened.width,
                    opened.height,
                    caps,
                    openedIdentity,
                    openedAttachmentKey,
                )
            }
        }
    }

    private fun publishFrame(nv21: ByteArray, width: Int, height: Int, gen: Int) {
        frameCounter += 1
        if (frameCounter % frameStride != 0) return
        if (!isLive(gen)) return
        if (!frameSlotBusy.compareAndSet(false, true)) return
        val step = maxOf(1, width / maxPreviewWidth)
        val outW = maxOf(1, width / step)
        val outH = maxOf(1, height / step)
        if (width <= 0 || height <= 0 || nv21.size < width * height) {
            frameSlotBusy.set(false)
            return
        }
        val needed = outW * outH
        var pixels = freeArgb
        if (pixels == null || pixels.size != needed) {
            pixels = IntArray(needed)
        } else {
            freeArgb = null
        }
        var i = 0
        var y = 0
        while (y < outH) {
            val row = (y * step) * width
            var x = 0
            while (x < outW) {
                val luma = nv21[row + x * step].toInt() and 0xFF
                pixels[i++] = 0xff000000.toInt() or (luma shl 16) or (luma shl 8) or luma
                x += 1
            }
            y += 1
        }
        if (!isLive(gen)) {
            freeArgb = pixels
            frameSlotBusy.set(false)
            return
        }
        val frame = PreviewFrame(gen, pixels, outW, outH)
        pendingFrame.set(frame)
        val target = listener
        if (target == null || !isLive(gen)) {
            if (pendingFrame.compareAndSet(frame, null)) {
                freeArgb = pixels
                frameSlotBusy.set(false)
            }
            return
        }
        try {
            target.onFrame(frame)
        } catch (t: Throwable) {
            Log.e(TAG, "onFrame failed", t)
            if (pendingFrame.compareAndSet(frame, null)) {
                freeArgb = pixels
                frameSlotBusy.set(false)
            }
        }
    }

    private fun releaseOwned(upToGen: Int) {
        if (handleGen > upToGen) return
        val h = handle
        handle = 0L
        handleGen = 0
        val owned = fd
        fd = null
        openedIdentity = null
        openedAttachmentKey = null
        closeNativeThenFd(h, owned)
        // Do not clear frameSlotBusy or reclaim pending pixels — UI may still hold the frame.
        // freeArgb stays untouched unless no pending frame references a producer buffer.
        if (pendingFrame.get() == null) {
            freeArgb = null
            frameSlotBusy.set(false)
        }
    }

    private fun finishStop(gen: Int) {
        // Single-use: only the matching stop generation may notify. Never mutates a newer
        // instance (there is none on this object); rejects late callbacks from superseded gens.
        val target = listener
        if (gen == generation.get()) {
            runCatching { target?.onStopped(gen) }
        }
    }

    private fun notifyFailed(gen: Int, reason: String) {
        val target = listener
        if (target != null && gen == generation.get()) {
            runCatching { target.onFailed(gen, reason) }
        }
    }

    private fun closeNativeThenFd(h: Long, owned: AuthorizedCameraFd?) {
        try {
            if (h != 0L) uvcEngine.close(h)
        } catch (t: Throwable) {
            Log.e(TAG, "native close failed", t)
        } finally {
            closeFd(owned)
        }
    }

    private fun closeFd(owned: AuthorizedCameraFd?) {
        if (owned == null) return
        try {
            owned.close()
        } catch (t: Throwable) {
            Log.e(TAG, "fd close failed", t)
        }
    }

    private companion object {
        const val TAG = "FitbausWebcamPreview"
    }
}
