// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

public class ArcadePreview internal constructor() {
    private val lock = Any()
    private var pixels = IntArray(0)
    private var width = 0
    private var height = 0
    private var pointX = Float.NaN
    private var pointY = Float.NaN
    private var regionLeft = 0f
    private var regionTop = 0f
    private var regionRight = 1f
    private var regionBottom = 1f
    private var version = 0L
    private var generation = 0

    internal var bufferAllocations: Int = 0
        private set

    internal fun currentGeneration(): Int = synchronized(lock) { generation }

    internal fun publish(
        source: IntArray,
        width: Int,
        height: Int,
        pointX: Float,
        pointY: Float,
        regionLeft: Float,
        regionTop: Float,
        regionRight: Float,
        regionBottom: Float,
        generation: Int,
    ) {
        val count = width * height
        synchronized(lock) {
            if (generation != this.generation) return
            if (pixels.size != count) {
                pixels = IntArray(count)
                bufferAllocations += 1
            }
            System.arraycopy(source, 0, pixels, 0, count)
            this.width = width
            this.height = height
            this.pointX = pointX
            this.pointY = pointY
            this.regionLeft = regionLeft
            this.regionTop = regionTop
            this.regionRight = regionRight
            this.regionBottom = regionBottom
            version += 1
        }
    }

    internal fun clear() {
        synchronized(lock) {
            generation += 1
            width = 0
            height = 0
            pointX = Float.NaN
            pointY = Float.NaN
            version += 1
        }
    }

    internal fun copyTo(target: PreviewSnapshot): Boolean {
        synchronized(lock) {
            if (target.version == version) return false
            val count = width * height
            if (target.pixels.size < count) target.pixels = IntArray(count)
            System.arraycopy(pixels, 0, target.pixels, 0, count)
            target.width = width
            target.height = height
            target.pointX = pointX
            target.pointY = pointY
            target.regionLeft = regionLeft
            target.regionTop = regionTop
            target.regionRight = regionRight
            target.regionBottom = regionBottom
            target.version = version
            return true
        }
    }
}

internal class PreviewSnapshot {
    var pixels: IntArray = IntArray(0)
    var width: Int = 0
    var height: Int = 0
    var pointX: Float = Float.NaN
    var pointY: Float = Float.NaN
    var regionLeft: Float = 0f
    var regionTop: Float = 0f
    var regionRight: Float = 1f
    var regionBottom: Float = 1f
    var version: Long = -1L
}
