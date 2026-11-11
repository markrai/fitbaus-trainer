// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

internal data class TrackerConfig(
    /** Target number of grid columns; the frame is point-sampled every width/gridWidth pixels. */
    val gridWidth: Int = 80,
    /** Luma change (0..255) that counts as motion for a grid cell. */
    val motionThreshold: Int = 18,
    /** Frames a cell stays "recently moving" after its last motion. */
    val motionHoldFrames: Int = 6,
    /** NV21 V byte (Cr) and U byte (Cb) skin window. */
    val crMin: Int = 133,
    val crMax: Int = 173,
    val cbMin: Int = 77,
    val cbMax: Int = 127,
    val foregroundLumaThreshold: Int = 24,
    val foregroundChromaThreshold: Int = 16,
    val backgroundShift: Int = 4,
    val acquireCells: Int = 14,
    val keepCells: Int = 8,
    /** Moving-skin cells at which confidence reaches 1. */
    val fullConfidenceCells: Int = 60,
    /** Width of the column window used to isolate one hand, as a fraction of the grid. */
    val windowFraction: Float = 0.2f,
    val searchRadiusFraction: Float = 0.15f,
    val graceFrames: Int = 4,
    /** Exponential smoothing factor (1 = none). */
    val smoothing: Float = 0.5f,
    val region: CameraRegion = DEFAULT_REGION,
) {
    init {
        require(gridWidth >= 8) { "gridWidth too small" }
        require(motionHoldFrames >= 1) { "motionHoldFrames must be >= 1" }
        require(smoothing > 0f && smoothing <= 1f) { "smoothing must be in (0, 1]" }
        require(windowFraction > 0f && windowFraction <= 1f) { "windowFraction must be in (0, 1]" }
        require(searchRadiusFraction > 0f && searchRadiusFraction <= 1f) { "searchRadiusFraction must be in (0, 1]" }
        require(backgroundShift in 1..8) { "backgroundShift must be in 1..8" }
        require(keepCells >= 1 && acquireCells >= keepCells) { "acquireCells must be >= keepCells >= 1" }
        require(graceFrames >= 0) { "graceFrames must be >= 0" }
    }

    companion object {
        val DEFAULT_REGION: CameraRegion = CameraRegion.DEFAULT_DETECTION
    }
}

/** Camera-space point: x 0 = left of the raw (unmirrored) frame, y 0 = top. */
internal data class TrackerPoint(val x: Float, val y: Float, val confidence: Float)

/**
 * Classical bare-hand tracker for NV21 frames on a coarse point-sampled grid limited to
 * [TrackerConfig.region]. Recent motion on skin-coloured cells acquires a hand; once acquired,
 * skin cells that are moving or differ from a slowly learned background keep it tracked near
 * its last position, so a hand held still stays tracked while visible. When those cells vanish
 * for more than [TrackerConfig.graceFrames] frames the track is dropped and only motion can
 * re-acquire. Frames without a confident hand return null.
 *
 * Pure Kotlin, single-threaded (call from the camera thread only). Buffers are allocated on the
 * first frame and when the frame size changes; steady-state frames allocate only the returned point.
 */
internal class ClassicalHandTracker(private val config: TrackerConfig = TrackerConfig()) {
    var bufferAllocations: Int = 0
        private set
    var gridColumns: Int = 0
        private set
    var gridRows: Int = 0
        private set
    var regionColumns: Int = 0
        private set
    var regionRows: Int = 0
        private set
    var isTracking: Boolean = false
        private set

    val region: CameraRegion
        get() = config.region

    private var frameWidth = 0
    private var frameHeight = 0
    private var step = 1
    private var originColumn = 0
    private var originRow = 0
    private var previousLuma = IntArray(0)
    private var backgroundLuma = IntArray(0)
    private var backgroundCr = IntArray(0)
    private var backgroundCb = IntArray(0)
    private var motion = IntArray(0)
    private var flags = ByteArray(0)
    private var columns = IntArray(0)
    private var hasPrevious = false
    private var hasSmoothed = false
    private var smoothX = 0f
    private var smoothY = 0f
    private var trackColumn = 0f
    private var trackRow = 0f
    private var misses = 0
    private var cellsFound = 0
    private var sumColumn = 0L
    private var sumRow = 0L

    fun reset() {
        hasPrevious = false
        dropTrack()
        motion.fill(0)
    }

    fun process(nv21: ByteArray, width: Int, height: Int): TrackerPoint? {
        require(width >= 2 && height >= 2) { "frame too small: ${width}x$height" }
        require(nv21.size >= width * height * 3 / 2) { "NV21 buffer too small for ${width}x$height" }
        ensureBuffers(width, height)
        val compare = hasPrevious
        sample(nv21, width, height, compare)
        if (!compare) {
            hasPrevious = true
            return null
        }
        val point = (if (isTracking) track() else null) ?: acquire()
        if (point == null && isTracking) {
            misses += 1
            if (misses > config.graceFrames) dropTrack()
        }
        return point
    }

    private fun ensureBuffers(width: Int, height: Int) {
        if (width == frameWidth && height == frameHeight) return
        frameWidth = width
        frameHeight = height
        step = max(1, width / config.gridWidth)
        gridColumns = width / step
        gridRows = height / step
        val r = config.region
        originColumn = floor(r.left * gridColumns).toInt().coerceIn(0, gridColumns - 1)
        originRow = floor(r.top * gridRows).toInt().coerceIn(0, gridRows - 1)
        regionColumns = (ceil(r.right * gridColumns).toInt().coerceAtMost(gridColumns) - originColumn).coerceAtLeast(1)
        regionRows = (ceil(r.bottom * gridRows).toInt().coerceAtMost(gridRows) - originRow).coerceAtLeast(1)
        val cells = regionColumns * regionRows
        previousLuma = IntArray(cells)
        backgroundLuma = IntArray(cells)
        backgroundCr = IntArray(cells)
        backgroundCb = IntArray(cells)
        motion = IntArray(cells)
        flags = ByteArray(cells)
        columns = IntArray(regionColumns)
        bufferAllocations += 1
        hasPrevious = false
        dropTrack()
    }

    private fun sample(nv21: ByteArray, width: Int, height: Int, compare: Boolean) {
        val chromaBase = width * height
        val half = step / 2
        val c = config
        var index = 0
        for (ry in 0 until regionRows) {
            val py = (originRow + ry) * step + half
            val lumaRow = py * width
            val chromaRow = chromaBase + (py shr 1) * width
            for (rx in 0 until regionColumns) {
                val px = (originColumn + rx) * step + half
                val luma = nv21[lumaRow + px].toInt() and 0xFF
                val chroma = chromaRow + (px and 1.inv())
                val cr = nv21[chroma].toInt() and 0xFF
                val cb = nv21[chroma + 1].toInt() and 0xFF
                var cell = 0
                if (compare) {
                    if (abs(luma - previousLuma[index]) >= c.motionThreshold) {
                        motion[index] = c.motionHoldFrames
                    } else if (motion[index] > 0) {
                        motion[index] -= 1
                    }
                    if (motion[index] > 0) cell = cell or MOVING
                    val lumaDelta = abs(luma - (backgroundLuma[index] shr FIXED))
                    val chromaDelta = abs(cr - (backgroundCr[index] shr FIXED)) + abs(cb - (backgroundCb[index] shr FIXED))
                    if (lumaDelta >= c.foregroundLumaThreshold || chromaDelta >= c.foregroundChromaThreshold) {
                        cell = cell or FOREGROUND
                    }
                    if (flags[index].toInt() and HAND == 0) {
                        backgroundLuma[index] += ((luma shl FIXED) - backgroundLuma[index]) shr c.backgroundShift
                        backgroundCr[index] += ((cr shl FIXED) - backgroundCr[index]) shr c.backgroundShift
                        backgroundCb[index] += ((cb shl FIXED) - backgroundCb[index]) shr c.backgroundShift
                    }
                } else {
                    motion[index] = 0
                    backgroundLuma[index] = luma shl FIXED
                    backgroundCr[index] = cr shl FIXED
                    backgroundCb[index] = cb shl FIXED
                }
                if (cr >= c.crMin && cr <= c.crMax && cb >= c.cbMin && cb <= c.cbMax) cell = cell or SKIN
                previousLuma[index] = luma
                flags[index] = cell.toByte()
                index += 1
            }
        }
    }

    private fun acquire(): TrackerPoint? {
        val cols = regionColumns
        val rows = regionRows
        columns.fill(0)
        var total = 0
        var index = 0
        for (ry in 0 until rows) {
            for (rx in 0 until cols) {
                if (isCandidate(flags[index].toInt())) {
                    columns[rx] += 1
                    total += 1
                }
                index += 1
            }
        }
        if (total < config.acquireCells) return null
        val window = min(cols, max(1, (cols * config.windowFraction).roundToInt()))
        var sum = 0
        for (rx in 0 until window) sum += columns[rx]
        var best = sum
        var bestStart = 0
        for (start in 1..cols - window) {
            sum += columns[start + window - 1] - columns[start - 1]
            if (sum > best) {
                best = sum
                bestStart = start
            }
        }
        if (best < config.acquireCells) return null
        collect(bestStart, bestStart + window, 0, rows, acquiring = true)
        if (cellsFound < config.acquireCells) return null
        hasSmoothed = false
        return accept()
    }

    private fun track(): TrackerPoint? {
        val radiusX = max(3, (gridColumns * config.searchRadiusFraction).roundToInt())
        val radiusY = max(3, (gridRows * config.searchRadiusFraction).roundToInt())
        val centerX = trackColumn.toInt()
        val centerY = trackRow.toInt()
        collect(
            max(0, centerX - radiusX),
            min(regionColumns, centerX + radiusX + 1),
            max(0, centerY - radiusY),
            min(regionRows, centerY + radiusY + 1),
            acquiring = false,
        )
        if (cellsFound < config.keepCells) return null
        return accept()
    }

    private fun collect(x0: Int, x1: Int, y0: Int, y1: Int, acquiring: Boolean) {
        var n = 0
        var sx = 0L
        var sy = 0L
        for (ry in y0 until y1) {
            val row = ry * regionColumns
            for (rx in x0 until x1) {
                val cell = flags[row + rx].toInt()
                val hit = if (acquiring) isCandidate(cell) else isContinuation(cell)
                if (hit) {
                    flags[row + rx] = (cell or HAND).toByte()
                    sx += rx
                    sy += ry
                    n += 1
                }
            }
        }
        cellsFound = n
        sumColumn = sx
        sumRow = sy
    }

    private fun accept(): TrackerPoint {
        val n = cellsFound
        trackColumn = sumColumn.toFloat() / n
        trackRow = sumRow.toFloat() / n
        isTracking = true
        misses = 0
        val cx = (originColumn + trackColumn + 0.5f) / gridColumns
        val cy = (originRow + trackRow + 0.5f) / gridRows
        if (hasSmoothed) {
            smoothX += config.smoothing * (cx - smoothX)
            smoothY += config.smoothing * (cy - smoothY)
        } else {
            smoothX = cx
            smoothY = cy
            hasSmoothed = true
        }
        return TrackerPoint(smoothX, smoothY, min(1f, n.toFloat() / config.fullConfidenceCells))
    }

    private fun dropTrack() {
        isTracking = false
        hasSmoothed = false
        misses = 0
    }

    fun renderPreview(nv21: ByteArray, width: Int, mirror: Boolean, dest: IntArray) {
        val cols = gridColumns
        val rows = gridRows
        val half = step / 2
        var index = 0
        for (gy in 0 until rows) {
            val lumaRow = (gy * step + half) * width
            val ry = gy - originRow
            val rowInRegion = ry >= 0 && ry < regionRows
            for (gx in 0 until cols) {
                val sx = if (mirror) cols - 1 - gx else gx
                val luma = nv21[lumaRow + sx * step + half].toInt() and 0xFF
                val rx = sx - originColumn
                val hand = rowInRegion && rx >= 0 && rx < regionColumns && flags[ry * regionColumns + rx].toInt() and HAND != 0
                dest[index] = if (hand) {
                    OPAQUE or ((luma shr 2) shl 16) or (((luma shr 1) + 128) shl 8) or (luma shr 2)
                } else {
                    OPAQUE or (luma shl 16) or (luma shl 8) or luma
                }
                index += 1
            }
        }
    }

    private fun isCandidate(cell: Int): Boolean = cell and SKIN != 0 && cell and MOVING != 0

    private fun isContinuation(cell: Int): Boolean = cell and SKIN != 0 && cell and (MOVING or FOREGROUND) != 0

    private companion object {
        const val SKIN = 1
        const val MOVING = 2
        const val FOREGROUND = 4
        const val HAND = 8
        const val FIXED = 4
        const val OPAQUE = -0x1000000
    }
}

/**
 * Camera-thread glue: runs the tracker on (every Nth) frame, maps the point from the tracker's
 * detection region to playground space and publishes it to [input] under the generation captured
 * when the camera session started.
 */
internal class TrackingFrameSink(
    private val tracker: ClassicalHandTracker,
    private val input: HandPositionInput,
    private val generation: Int,
    private val processEvery: Int = 1,
    private val clock: () -> Long = { System.nanoTime() },
    private val preview: ArcadePreview? = null,
    private val previewEvery: Int = DEFAULT_PREVIEW_EVERY,
) : FrameConsumer {
    init {
        require(processEvery >= 1) { "processEvery must be >= 1" }
        require(previewEvery >= 1) { "previewEvery must be >= 1" }
    }

    private val previewGeneration = preview?.currentGeneration() ?: 0
    private var previewPixels = IntArray(0)
    private var previewCountdown = 0

    var previewBufferAllocations: Int = 0
        private set

    @Volatile
    override var mirror: Boolean = true

    override val failure: String? = null

    @Volatile
    var processedFrames: Long = 0L
        private set

    @Volatile
    var lastTrackerMicros: Long = 0L
        private set

    private val durations = DurationWindow()
    private var wasTracking = false
    private var everTracked = false

    @Volatile
    private var losses = 0

    @Volatile
    private var reacquisitions = 0

    val bufferAllocations: Int
        get() = tracker.bufferAllocations

    private var skipped = 0

    /** Returns true when the frame was run through the tracker. */
    override fun onFrame(nv21: ByteArray, width: Int, height: Int): Boolean {
        skipped += 1
        if (skipped < processEvery) return false
        skipped = 0
        val start = clock()
        val point = tracker.process(nv21, width, height)
        val end = clock()
        lastTrackerMicros = (end - start) / 1_000L
        durations.record((end - start) / 1_000_000f)
        processedFrames += 1
        val tracking = tracker.isTracking
        if (wasTracking && !tracking) losses += 1
        if (!wasTracking && tracking) {
            if (everTracked) reacquisitions += 1
            everTracked = true
        }
        wasTracking = tracking
        if (point != null) {
            val mapped = HandMapping.fromCamera(point.x, point.y, mirror, tracker.region)
            input.publishCamera(mapped.x, mapped.y, point.confidence, end, generation)
        }
        if (preview != null) {
            previewCountdown -= 1
            if (previewCountdown <= 0) {
                previewCountdown = previewEvery
                publishPreview(preview, nv21, width, point)
            }
        }
        return true
    }

    override fun close() {
    }

    override fun stats(): TrackerStats {
        val p50 = durations.percentile(0.5f)
        return TrackerStats(
            mode = ArcadeTrackerMode.Classical,
            processedFrames = processedFrames,
            processingP50Ms = p50,
            processingP90Ms = durations.percentile(0.9f),
            inferenceP50Ms = p50,
            frameAgeP50Ms = 0f,
            framesSuperseded = 0L,
            trackingLosses = losses,
            reacquisitions = reacquisitions,
            lastError = null,
        )
    }

    private fun publishPreview(target: ArcadePreview, nv21: ByteArray, width: Int, point: TrackerPoint?) {
        val count = tracker.gridColumns * tracker.gridRows
        if (count <= 0) return
        if (previewPixels.size != count) {
            previewPixels = IntArray(count)
            previewBufferAllocations += 1
        }
        val flip = mirror
        tracker.renderPreview(nv21, width, flip, previewPixels)
        val r = tracker.region
        val px = if (point == null) Float.NaN else if (flip) 1f - point.x else point.x
        val py = point?.y ?: Float.NaN
        target.publish(
            previewPixels,
            tracker.gridColumns,
            tracker.gridRows,
            px,
            py,
            if (flip) 1f - r.right else r.left,
            r.top,
            if (flip) 1f - r.left else r.right,
            r.bottom,
            previewGeneration,
        )
    }

    companion object {
        const val DEFAULT_PREVIEW_EVERY: Int = 5
    }
}
