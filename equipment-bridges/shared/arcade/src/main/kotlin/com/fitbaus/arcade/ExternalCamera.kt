// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.util.Log

/**
 * Host-owned authorized USB Host file descriptor for a UVC webcam.
 *
 * Arcade never enumerates or claims USB devices. The host must keep the underlying USB connection
 * open until [close] is called, and must call [close] only after [UvcNative.close] returns.
 */
public interface AuthorizedCameraFd : AutoCloseable {
    /** Dup of the authorized USB Host FD; valid until [close]. */
    public fun fileDescriptor(): Int

    /** Releases the host USB connection. Idempotent. */
    public override fun close()
}

/**
 * Supplies an authorized external UVC camera when one is available.
 * Invoked on the arcade camera worker thread (never the UI thread).
 * Return null to use the onboard Camera1 path.
 */
public fun interface ExternalCameraProvider {
    public fun openAuthorizedCamera(): AuthorizedCameraFd?
}

/** Result of a native UVC open; [handle] 0 means failure. */
internal data class UvcOpenResult(val handle: Long, val width: Int, val height: Int)

/** Native UVC open/close seam; default delegates to [UvcNative]. */
internal interface UvcStreamEngine {
    fun open(fileDescriptor: Int, sink: UvcNative.Sink): UvcOpenResult
    fun close(handle: Long)

    companion object {
        val DEFAULT: UvcStreamEngine = object : UvcStreamEngine {
            override fun open(fileDescriptor: Int, sink: UvcNative.Sink): UvcOpenResult {
                UvcNative.ensureLoaded()
                val handle = UvcNative.open(fileDescriptor, sink)
                if (handle == 0L) return UvcOpenResult(0L, 0, 0)
                try {
                    val width = UvcNative.negotiatedWidth(handle)
                    val height = UvcNative.negotiatedHeight(handle)
                    if (width <= 0 || height <= 0) {
                        UvcNative.close(handle)
                        return UvcOpenResult(0L, 0, 0)
                    }
                    return UvcOpenResult(handle, width, height)
                } catch (t: Throwable) {
                    try {
                        UvcNative.close(handle)
                    } catch (_: Throwable) {
                    }
                    throw t
                }
            }

            override fun close(handle: Long) {
                UvcNative.close(handle)
            }
        }
    }
}

/**
 * Prefers a host-authorized UVC stream; on any failure cleans up and opens Camera1.
 * UVC → Camera1 selection happens at [start] only (no mid-game hot-plug switching).
 */
internal class PreferExternalCameraFrameSource(
    private val worker: CameraWorker,
    private val sink: FrameConsumer,
    private val external: ExternalCameraProvider?,
    private val uvcEngine: UvcStreamEngine = UvcStreamEngine.DEFAULT,
    private val camera1Factory: (FrameConsumer) -> FrameSource = { s ->
        SerialCameraFrameSource(worker, Camera1Driver(s))
    },
    private val events: MutableList<String>? = null,
) : FrameSource {
    @Volatile
    private var stopped = false
    private var started = false

    @Volatile
    var releaseComplete: Boolean = false
        private set

    @Volatile
    var usedExternal: Boolean = false
        private set

    private var uvcHandle: Long = 0L
    private var uvcFd: AuthorizedCameraFd? = null
    private var camera1: FrameSource? = null

    private val uvcSink = object : UvcNative.Sink {
        override fun onFrame(nv21: ByteArray, width: Int, height: Int) {
            if (stopped) return
            sink.onFrame(nv21, width, height)
        }
    }

    override fun start(listener: FrameSourceListener) {
        if (started || stopped) return
        started = true
        worker.post {
            try {
                openOnWorker(listener)
            } catch (t: Throwable) {
                Log.e(TAG, "UVC/Camera1 open failed", t)
                releaseOwnedResources()
                if (!stopped) {
                    try {
                        startCamera1(listener)
                    } catch (fallback: Throwable) {
                        Log.e(TAG, "Camera1 fallback failed", fallback)
                        if (!stopped) listener.onCameraFailed(fallback.message ?: "camera open failed")
                    }
                }
            }
        }
    }

    override fun stop() {
        if (stopped) return
        stopped = true
        if (!started) {
            releaseComplete = true
            return
        }
        worker.post {
            try {
                releaseOwnedResources()
            } catch (t: Throwable) {
                Log.e(TAG, "camera release failed", t)
            } finally {
                releaseComplete = true
            }
        }
    }

    private fun openOnWorker(listener: FrameSourceListener) {
        if (stopped) return
        if (tryStartUvc(listener)) return
        if (stopped) return
        startCamera1(listener)
    }

    private fun startCamera1(listener: FrameSourceListener) {
        val fallback = camera1Factory(sink)
        camera1 = fallback
        usedExternal = false
        fallback.start(listener)
    }

    private fun tryStartUvc(listener: FrameSourceListener): Boolean {
        val provider = external ?: return false
        val fd = try {
            provider.openAuthorizedCamera()
        } catch (t: Throwable) {
            Log.e(TAG, "external camera provider failed", t)
            null
        } ?: return false

        if (stopped) {
            closeFd(fd, "stop-before-native")
            return false
        }

        val opened = try {
            uvcEngine.open(fd.fileDescriptor(), uvcSink)
        } catch (t: Throwable) {
            Log.e(TAG, "UvcNative.open failed", t)
            // Engine must release any nonzero handle before throwing; only the FD remains.
            closeFd(fd, "native-open-exception")
            return false
        }

        if (opened.handle == 0L) {
            closeFd(fd, "native-open-zero")
            return false
        }
        if (opened.width <= 0 || opened.height <= 0) {
            closeNativeThenFd(opened.handle, fd, "native-bad-dims")
            return false
        }

        if (stopped) {
            closeNativeThenFd(opened.handle, fd, "stop-after-native")
            return false
        }

        uvcHandle = opened.handle
        uvcFd = fd
        usedExternal = true
        sink.mirror = false
        Log.i(TAG, "using external UVC ${opened.width}x${opened.height}")
        listener.onCameraReady(opened.width, opened.height, false)
        return true
    }

    private fun releaseOwnedResources() {
        val handle = uvcHandle
        uvcHandle = 0L
        val fd = uvcFd
        uvcFd = null
        val cam = camera1
        camera1 = null
        try {
            if (handle != 0L || fd != null) {
                closeNativeThenFd(handle, fd, "release")
            }
        } finally {
            try {
                cam?.stop()
            } catch (t: Throwable) {
                Log.e(TAG, "Camera1 stop failed", t)
            }
        }
    }

    /** Always closes [fd] after native close; logs failures; never throws (keeps shared worker alive). */
    private fun closeNativeThenFd(handle: Long, fd: AuthorizedCameraFd?, reason: String) {
        try {
            if (handle != 0L) {
                trace("nativeClose:$reason")
                uvcEngine.close(handle)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "UvcNative.close failed ($reason)", t)
            trace("nativeCloseError:$reason")
        } finally {
            closeFd(fd, reason)
        }
    }

    private fun closeFd(fd: AuthorizedCameraFd?, reason: String) {
        if (fd == null) return
        try {
            trace("fdClose:$reason")
            fd.close()
        } catch (t: Throwable) {
            Log.e(TAG, "AuthorizedCameraFd.close failed ($reason)", t)
        }
    }

    private fun trace(event: String) {
        events?.add(event)
    }

    companion object {
        private const val TAG = "FitbausExtCam"
    }
}
