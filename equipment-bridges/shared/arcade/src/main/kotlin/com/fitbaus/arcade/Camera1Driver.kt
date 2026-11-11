// SPDX-License-Identifier: AGPL-3.0-only
@file:Suppress("DEPRECATION")

package com.fitbaus.arcade

import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.Camera
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import java.io.IOException

/**
 * Legacy android.hardware.Camera (Camera1) NV21 preview driver. The console reports a single
 * HAL v1 camera, so Camera1 avoids the Camera2 legacy shim. Every call must come from
 * [ArcadeCameraThread]; preview frames are delivered on that same thread.
 */
internal class Camera1Driver(
    private val sink: FrameConsumer,
    private val targetWidth: Int = CameraPreviewPolicy.TARGET_WIDTH,
) : CameraDriver {
    private var camera: Camera? = null
    private var texture: SurfaceTexture? = null
    private var frameWidth = 0
    private var frameHeight = 0

    private val callback = Camera.PreviewCallback { data, cam ->
        if (data != null && camera != null) {
            try {
                sink.onFrame(data, frameWidth, frameHeight)
            } finally {
                cam?.addCallbackBuffer(data)
            }
        }
    }

    override fun open(onError: (String) -> Unit): CameraOpenResult {
        return try {
            val count = Camera.getNumberOfCameras()
            if (count <= 0) return CameraOpenResult.Failed("no camera")
            val info = Camera.CameraInfo()
            var id = 0
            var front = false
            for (i in 0 until count) {
                Camera.getCameraInfo(i, info)
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
                    id = i
                    front = true
                    break
                }
            }
            val cam = Camera.open(id) ?: return CameraOpenResult.Failed("camera $id did not open")
            camera = cam
            val params = cam.parameters
            val sizes = params.supportedPreviewSizes.orEmpty().map { PreviewSize(it.width, it.height) }
            val size = CameraPreviewPolicy.choose(sizes, targetWidth)
                ?: return CameraOpenResult.Failed("no preview sizes")
            if (params.supportedPreviewFormats?.contains(ImageFormat.NV21) != true) {
                return CameraOpenResult.Failed("NV21 preview unsupported")
            }
            params.setPreviewSize(size.width, size.height)
            params.previewFormat = ImageFormat.NV21
            cam.parameters = params
            val actual = cam.parameters.previewSize
            frameWidth = actual.width
            frameHeight = actual.height
            sink.mirror = front
            val bufferSize = CameraPreviewPolicy.nv21BufferSize(frameWidth, frameHeight)
            repeat(CALLBACK_BUFFERS) { cam.addCallbackBuffer(ByteArray(bufferSize)) }
            cam.setPreviewCallbackWithBuffer(callback)
            cam.setErrorCallback { error, _ -> onError("camera error $error") }
            val surface = SurfaceTexture(DUMMY_TEXTURE_NAME)
            texture = surface
            cam.setPreviewTexture(surface)
            cam.startPreview()
            CameraOpenResult.Opened(frameWidth, frameHeight, front)
        } catch (e: RuntimeException) {
            CameraOpenResult.Failed(describe(e))
        } catch (e: IOException) {
            CameraOpenResult.Failed(describe(e))
        }
    }

    override fun release() {
        val cam = camera
        camera = null
        if (cam != null) {
            try {
                cam.setPreviewCallbackWithBuffer(null)
                cam.setErrorCallback(null)
                cam.stopPreview()
            } catch (_: RuntimeException) {
            }
            try {
                cam.release()
            } catch (_: RuntimeException) {
            }
        }
        texture?.release()
        texture = null
    }

    private fun describe(e: Exception): String = e.javaClass.simpleName + (e.message?.let { ": $it" } ?: "")

    private companion object {
        const val CALLBACK_BUFFERS = 3
        const val DUMMY_TEXTURE_NAME = 10
    }
}

/** Process-wide serial camera thread, started on first use and kept for the life of the process. */
internal object ArcadeCameraThread : CameraWorker {
    private var handler: Handler? = null

    @Synchronized
    private fun handler(): Handler =
        handler ?: HandlerThread("fitbaus-arcade-camera", Process.THREAD_PRIORITY_DEFAULT)
            .also { it.start() }
            .let { Handler(it.looper) }
            .also { handler = it }

    override fun post(task: () -> Unit) {
        handler().post { task() }
    }
}
