// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.content.Context
import java.io.File

internal object NativeHandBridge {
    @JvmStatic
    external fun nativeCreate(tfliteLibrary: String, palmModel: ByteArray?, landmarkModel: ByteArray?, faceModel: ByteArray?, threads: Int): Long

    @JvmStatic
    external fun nativeLastError(): String

    @JvmStatic
    external fun nativeDetectPalms(
        handle: Long,
        frame: ByteArray,
        width: Int,
        height: Int,
        minScore: Float,
        out: FloatArray,
        maxOut: Int,
        times: FloatArray,
    ): Int

    @JvmStatic
    external fun nativeLandmarks(
        handle: Long,
        frame: ByteArray,
        width: Int,
        height: Int,
        cx: Float,
        cy: Float,
        size: Float,
        rotation: Float,
        out: FloatArray,
        times: FloatArray,
    ): Int

    @JvmStatic
    external fun nativeDetectFaces(
        handle: Long,
        frame: ByteArray,
        width: Int,
        height: Int,
        minScore: Float,
        out: FloatArray,
        maxOut: Int,
        times: FloatArray,
    ): Int

    @JvmStatic
    external fun nativeRenderPreview(handle: Long, frame: ByteArray, width: Int, height: Int, cols: Int, rows: Int, mirror: Boolean, out: IntArray)

    @JvmStatic
    external fun nativeDestroy(handle: Long)
}

/**
 * JNI endpoint for the UVC webcam path used by [PreferExternalCameraFrameSource].
 *
 * Ownership contract (host integration must enforce this outside arcade):
 * - The caller owns the authorized USB Host connection and its file descriptor for the entire
 *   native session. Pass that FD into [open] and do **not** close the connection until after
 *   [close] returns.
 * - Native wraps the FD via libusb/`uvc_wrap` and does not close it on [close]; it only stops
 *   streaming, releases UVC interface claims, and drops JNI globals.
 * - [Sink.onFrame] is invoked synchronously on a libuvc worker thread with a reusable NV21
 *   buffer owned by native until the callback returns. Exceptions from [Sink.onFrame] are
 *   cleared in native and must not be assumed fatal to the stream.
 * - [Sink.onFrame] must not call [close]; host shutdown posts close onto the camera worker.
 */
internal object UvcNative {
    interface Sink {
        fun onFrame(nv21: ByteArray, width: Int, height: Int)
    }

    /**
     * Opens a descriptor-negotiated YUYV stream on [fileDescriptor].
     * Returns 0 on failure with no active stream or claimed USB resources left behind.
     * On success, [negotiatedWidth]/[negotiatedHeight] report the chosen size.
     */
    @JvmStatic
    external fun open(fileDescriptor: Int, sink: Sink): Long

    @JvmStatic
    external fun negotiatedWidth(handle: Long): Int

    @JvmStatic
    external fun negotiatedHeight(handle: Long): Int

    /** Stops streaming and releases native resources. Safe on 0. Must precede FD close. */
    @JvmStatic
    external fun close(handle: Long)

    fun ensureLoaded() {
        System.loadLibrary(NativeHandModels.LIBRARY)
    }
}

internal class NativeHandModels private constructor(private var handle: Long) : HandModelBackend {
    override fun detectPalms(frame: ByteArray, width: Int, height: Int, minScore: Float, out: FloatArray, maxOut: Int, times: FloatArray): Int =
        if (handle == 0L) CLOSED else NativeHandBridge.nativeDetectPalms(handle, frame, width, height, minScore, out, maxOut, times)

    override fun landmarks(frame: ByteArray, width: Int, height: Int, roi: HandRoi, out: FloatArray, times: FloatArray): Int =
        if (handle == 0L) CLOSED else NativeHandBridge.nativeLandmarks(handle, frame, width, height, roi.cx, roi.cy, roi.size, roi.rotation, out, times)

    override fun detectFaces(frame: ByteArray, width: Int, height: Int, minScore: Float, out: FloatArray, maxOut: Int, times: FloatArray): Int =
        if (handle == 0L) CLOSED else NativeHandBridge.nativeDetectFaces(handle, frame, width, height, minScore, out, maxOut, times)

    override fun renderPreview(frame: ByteArray, width: Int, height: Int, cols: Int, rows: Int, mirror: Boolean, out: IntArray) {
        if (handle != 0L) NativeHandBridge.nativeRenderPreview(handle, frame, width, height, cols, rows, mirror, out)
    }

    override fun close() {
        val h = handle
        handle = 0L
        if (h != 0L) NativeHandBridge.nativeDestroy(h)
    }

    companion object {
        const val LIBRARY: String = "fitbaus_arcade_hand"
        const val TFLITE_LIBRARY_FILE: String = "libtensorflowlite_jni.so"
        const val PALM_ASSET: String = "arcade/palm_detection_lite.tflite"
        const val LANDMARK_ASSET: String = "arcade/hand_landmark_lite.tflite"
        const val FACE_ASSET: String = "arcade/face_detection_short_range.tflite"
        const val CLOSED: Int = -100

        fun open(context: Context, threads: Int, face: Boolean = false): NativeHandModels {
            System.loadLibrary(LIBRARY)
            val runtime = File(context.applicationInfo.nativeLibraryDir, TFLITE_LIBRARY_FILE)
            check(runtime.isFile) { "TFLite runtime missing at ${runtime.path}" }
            fun asset(name: String): ByteArray = context.assets.open(name).use { it.readBytes() }
            val handle = if (face) {
                NativeHandBridge.nativeCreate(runtime.path, null, null, asset(FACE_ASSET), threads)
            } else {
                NativeHandBridge.nativeCreate(runtime.path, asset(PALM_ASSET), asset(LANDMARK_ASSET), null, threads)
            }
            check(handle != 0L) { NativeHandBridge.nativeLastError() }
            return NativeHandModels(handle)
        }
    }
}
