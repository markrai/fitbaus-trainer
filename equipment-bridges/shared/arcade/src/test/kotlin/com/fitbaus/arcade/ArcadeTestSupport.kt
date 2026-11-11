// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

internal object Nv21Frames {
    const val BACKGROUND_LUMA: Int = 60
    const val NEUTRAL_CHROMA: Int = 128
    const val SKIN_CR: Int = 150
    const val SKIN_CB: Int = 100

    class Blob(val x: Int, val y: Int, val size: Int, val luma: Int = 150, val skin: Boolean = true)

    fun allocate(width: Int, height: Int): ByteArray = ByteArray(width * height * 3 / 2)

    /** Rewrites [frame] in place (no allocation) with a flat background and the given blobs. */
    fun paint(frame: ByteArray, width: Int, height: Int, vararg blobs: Blob): ByteArray {
        val lumaSize = width * height
        java.util.Arrays.fill(frame, 0, lumaSize, BACKGROUND_LUMA.toByte())
        java.util.Arrays.fill(frame, lumaSize, frame.size, NEUTRAL_CHROMA.toByte())
        for (blob in blobs) {
            for (y in blob.y until minOf(height, blob.y + blob.size)) {
                for (x in blob.x until minOf(width, blob.x + blob.size)) {
                    if (x < 0 || y < 0) continue
                    frame[y * width + x] = blob.luma.toByte()
                    val c = lumaSize + (y shr 1) * width + (x and 1.inv())
                    frame[c] = (if (blob.skin) SKIN_CR else NEUTRAL_CHROMA).toByte()
                    frame[c + 1] = (if (blob.skin) SKIN_CB else NEUTRAL_CHROMA).toByte()
                }
            }
        }
        return frame
    }
}

internal class ArcadeToggle(private val session: ArcadeCameraSession) {
    var arcade: Boolean = false
        private set
    var isActive: Boolean = false
        private set
    private var resumed = false

    fun select(arcade: Boolean) {
        if (this.arcade != arcade) toggle()
    }

    fun toggle() {
        if (arcade) {
            deactivate(ArcadeStopReason.ExitArcade)
            arcade = false
        } else {
            arcade = true
            if (resumed) activate()
        }
    }

    fun onHostResume() {
        resumed = true
        if (arcade) activate()
    }

    fun onHostPause() {
        resumed = false
        deactivate(ArcadeStopReason.HostPaused)
    }

    private fun activate() {
        if (isActive) return
        isActive = true
        session.start()
    }

    private fun deactivate(reason: ArcadeStopReason) {
        if (!isActive) return
        isActive = false
        session.stop(reason)
    }
}

internal class FakePermission(var granted: Boolean, var requestable: Boolean = true) : CameraPermissionGate {
    var requests = 0

    override fun isGranted(): Boolean = granted

    override fun canRequest(): Boolean = requestable

    override fun request() {
        requests += 1
    }
}

internal class FakeFrameSource(val sink: FrameConsumer) : FrameSource {
    var listener: FrameSourceListener? = null
    var starts = 0
    var stops = 0

    override fun start(listener: FrameSourceListener) {
        starts += 1
        this.listener = listener
    }

    override fun stop() {
        stops += 1
    }
}
