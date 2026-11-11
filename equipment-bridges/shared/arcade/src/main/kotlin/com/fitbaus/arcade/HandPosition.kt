// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

public enum class HandSource { Touch, Camera, Lost }

/** Playground-space hand position: x 0 = player's left, 1 = player's right; y 0 = top, 1 = bottom. */
public data class HandPosition(
    public val x: Float,
    public val y: Float,
    public val confidence: Float,
    public val timestampNanos: Long,
    public val source: HandSource,
)

internal data class NormalizedPoint(val x: Float, val y: Float)

/** Sub-rectangle of the raw (unmirrored) camera frame that maps onto the whole playground. */
public data class CameraRegion(
    public val left: Float,
    public val top: Float,
    public val right: Float,
    public val bottom: Float,
) {
    init {
        require(right > left && bottom > top) { "empty camera region" }
        require(left >= 0f && top >= 0f && right <= 1f && bottom <= 1f) { "camera region outside the frame" }
    }

    public companion object {
        public val FULL: CameraRegion = CameraRegion(0f, 0f, 1f, 1f)
        public val DEFAULT_DETECTION: CameraRegion = CameraRegion(0f, 0.35f, 1f, 1f)

        /** Centre crop of the camera frame with the same aspect ratio as the playground. */
        public fun forAspect(cameraWidth: Int, cameraHeight: Int, viewWidth: Int, viewHeight: Int): CameraRegion {
            if (cameraWidth <= 0 || cameraHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) return FULL
            val cameraAspect = cameraWidth.toFloat() / cameraHeight
            val viewAspect = viewWidth.toFloat() / viewHeight
            return if (viewAspect > cameraAspect) {
                val visible = cameraAspect / viewAspect
                val margin = (1f - visible) / 2f
                CameraRegion(0f, margin, 1f, 1f - margin)
            } else {
                val visible = viewAspect / cameraAspect
                val margin = (1f - visible) / 2f
                CameraRegion(margin, 0f, 1f - margin, 1f)
            }
        }
    }
}

internal object HandMapping {
    fun clamp01(value: Float): Float = when {
        value.isNaN() -> 0.5f
        value < 0f -> 0f
        value > 1f -> 1f
        else -> value
    }

    fun normalize(position: Float, extent: Float): Float =
        if (extent <= 0f) 0.5f else clamp01(position / extent)

    fun fromTouch(px: Float, py: Float, viewWidth: Float, viewHeight: Float): NormalizedPoint =
        NormalizedPoint(normalize(px, viewWidth), normalize(py, viewHeight))

    /**
     * Camera frames from a front camera are not mirrored, so moving the right hand moves the
     * blob to camera-left. [mirror] flips x so the playground follows the player's hand.
     */
    fun fromCamera(cx: Float, cy: Float, mirror: Boolean, region: CameraRegion = CameraRegion.FULL): NormalizedPoint {
        val x = clamp01((clamp01(cx) - region.left) / (region.right - region.left))
        val y = clamp01((clamp01(cy) - region.top) / (region.bottom - region.top))
        return NormalizedPoint(if (mirror) 1f - x else x, y)
    }
}

/**
 * Merges camera tracking and touch into one playground position.
 *
 * Threading: camera samples are published from the camera thread through an atomic; touch and
 * [latest] are UI-thread only. [clearCamera] bumps a generation so a late sample from a stopped
 * camera session is never shown.
 */
public class HandPositionInput(
    private val holdNanos: Long = DEFAULT_HOLD_NANOS,
    private val freshNanos: Long = DEFAULT_FRESH_NANOS,
) {
    @Volatile
    private var activeHoldNanos: Long = holdNanos

    @Volatile
    private var activeFreshNanos: Long = freshNanos

    internal fun configureTiming(holdNanos: Long, freshNanos: Long) {
        activeHoldNanos = holdNanos
        activeFreshNanos = freshNanos.coerceAtMost(holdNanos)
    }

    internal fun resetTiming() {
        activeHoldNanos = holdNanos
        activeFreshNanos = freshNanos
    }

    private class CameraPoint(
        val x: Float,
        val y: Float,
        val confidence: Float,
        val timestampNanos: Long,
        val generation: Int,
    )

    private val generation = AtomicInteger(0)
    private val lastCamera = AtomicReference<CameraPoint?>(null)

    @Volatile
    private var touchDown = false

    @Volatile
    private var touchX = 0.5f

    @Volatile
    private var touchY = 0.5f
    private var lastKnownX = 0.5f
    private var lastKnownY = 0.5f
    private var trackedGeneration = -1

    internal fun cameraGeneration(): Int = generation.get()

    internal fun publishCamera(x: Float, y: Float, confidence: Float, timestampNanos: Long, generation: Int) {
        if (generation != this.generation.get()) return
        lastCamera.set(
            CameraPoint(HandMapping.clamp01(x), HandMapping.clamp01(y), HandMapping.clamp01(confidence), timestampNanos, generation),
        )
    }

    internal fun clearCamera() {
        generation.incrementAndGet()
        lastCamera.set(null)
    }

    internal fun onTouch(x: Float, y: Float) {
        touchX = HandMapping.clamp01(x)
        touchY = HandMapping.clamp01(y)
        touchDown = true
    }

    internal fun onTouchUp() {
        touchDown = false
    }

    public fun isTouching(): Boolean = touchDown

    public fun cameraTracking(nowNanos: Long): Boolean = validCamera(nowNanos) != null

    public fun hasEverTracked(): Boolean = trackedGeneration == generation.get()

    public fun latest(nowNanos: Long): HandPosition {
        if (touchDown) {
            lastKnownX = touchX
            lastKnownY = touchY
            return HandPosition(touchX, touchY, 1f, nowNanos, HandSource.Touch)
        }
        val camera = validCamera(nowNanos)
        if (camera != null) {
            lastKnownX = camera.x
            lastKnownY = camera.y
            val age = nowNanos - camera.timestampNanos
            val confidence = if (age <= activeFreshNanos) {
                camera.confidence
            } else {
                camera.confidence * (1f - (age - activeFreshNanos).toFloat() / (activeHoldNanos - activeFreshNanos).coerceAtLeast(1L))
            }
            return HandPosition(camera.x, camera.y, HandMapping.clamp01(confidence), camera.timestampNanos, HandSource.Camera)
        }
        return HandPosition(lastKnownX, lastKnownY, 0f, nowNanos, HandSource.Lost)
    }

    private fun validCamera(nowNanos: Long): CameraPoint? {
        val camera = lastCamera.get() ?: return null
        if (camera.generation != generation.get()) return null
        if (nowNanos - camera.timestampNanos > activeHoldNanos) return null
        trackedGeneration = camera.generation
        return camera
    }

    public companion object {
        public const val DEFAULT_HOLD_NANOS: Long = 500_000_000L
        public const val DEFAULT_FRESH_NANOS: Long = 150_000_000L
    }
}
