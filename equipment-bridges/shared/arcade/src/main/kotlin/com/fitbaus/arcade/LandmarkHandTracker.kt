// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

internal object HandModelLayout {
    const val PALM_KEYPOINTS = 7
    const val PALM_STRIDE = 5 + PALM_KEYPOINTS * 2
    const val LANDMARKS = 21
    const val LANDMARK_STRIDE = 2 + LANDMARKS * 2
    const val WRIST = 0
    const val INDEX_TIP = 8
    const val MIDDLE_MCP = 9
    const val FACE_KEYPOINTS = 6
    const val FACE_STRIDE = 5 + FACE_KEYPOINTS * 2
    const val FACE_NOSE = 2
}

internal interface NativeFrameTracker {
    val lastInferenceMs: Float
    val lastUpdateSearched: Boolean
    val isTracking: Boolean
    val lossCount: Int
    val reacquisitions: Int
    val backendErrors: Int
    val consecutiveBackendErrors: Int
    val lastBackendStatus: Int

    fun losses(reason: LossReason): Int

    fun process(frame: ByteArray, width: Int, height: Int, nowNanos: Long): LandmarkPoint?
}

internal interface HandModelBackend {
    fun detectPalms(frame: ByteArray, width: Int, height: Int, minScore: Float, out: FloatArray, maxOut: Int, times: FloatArray): Int

    fun landmarks(frame: ByteArray, width: Int, height: Int, roi: HandRoi, out: FloatArray, times: FloatArray): Int

    fun detectFaces(frame: ByteArray, width: Int, height: Int, minScore: Float, out: FloatArray, maxOut: Int, times: FloatArray): Int

    fun renderPreview(frame: ByteArray, width: Int, height: Int, cols: Int, rows: Int, mirror: Boolean, out: IntArray)

    fun close()
}

internal data class HandRoi(val cx: Float, val cy: Float, val size: Float, val rotation: Float)

internal object RoiMath {
    private val TRACKING_SUBSET = intArrayOf(0, 1, 2, 3, 5, 6, 9, 10, 13, 14, 17, 18)

    fun normalizeAngle(angle: Float): Float {
        val twoPi = (2 * PI).toFloat()
        return angle - twoPi * floor((angle + PI.toFloat()) / twoPi)
    }

    fun rotationBetween(startX: Float, startY: Float, endX: Float, endY: Float): Float =
        normalizeAngle((PI / 2).toFloat() - atan2(-(endY - startY), endX - startX))

    fun transform(cx: Float, cy: Float, width: Float, height: Float, rotation: Float, shiftY: Float, scale: Float): HandRoi {
        val x = cx - height * shiftY * sin(rotation)
        val y = cy + height * shiftY * cos(rotation)
        return HandRoi(x, y, max(width, height) * scale, rotation)
    }

    fun fromPalm(palm: FloatArray, offset: Int): HandRoi {
        val kp = offset + 5
        val rotation = rotationBetween(palm[kp], palm[kp + 1], palm[kp + 4], palm[kp + 5])
        return transform(palm[offset + 1], palm[offset + 2], palm[offset + 3], palm[offset + 4], rotation, -0.5f, 2.6f)
    }

    fun fromLandmarks(xy: FloatArray, offset: Int): HandRoi {
        val wx = xy[offset + HandModelLayout.WRIST * 2]
        val wy = xy[offset + HandModelLayout.WRIST * 2 + 1]
        val mx = xy[offset + HandModelLayout.MIDDLE_MCP * 2]
        val my = xy[offset + HandModelLayout.MIDDLE_MCP * 2 + 1]
        val rotation = rotationBetween(wx, wy, mx, my)
        var minX = Float.MAX_VALUE
        var maxX = -Float.MAX_VALUE
        var minY = Float.MAX_VALUE
        var maxY = -Float.MAX_VALUE
        for (id in TRACKING_SUBSET) {
            val x = xy[offset + id * 2]
            val y = xy[offset + id * 2 + 1]
            minX = min(minX, x)
            maxX = max(maxX, x)
            minY = min(minY, y)
            maxY = max(maxY, y)
        }
        val acx = (minX + maxX) / 2
        val acy = (minY + maxY) / 2
        val c = cos(-rotation)
        val s = sin(-rotation)
        var pMinX = Float.MAX_VALUE
        var pMaxX = -Float.MAX_VALUE
        var pMinY = Float.MAX_VALUE
        var pMaxY = -Float.MAX_VALUE
        for (id in TRACKING_SUBSET) {
            val x = xy[offset + id * 2] - acx
            val y = xy[offset + id * 2 + 1] - acy
            val px = x * c - y * s
            val py = x * s + y * c
            pMinX = min(pMinX, px)
            pMaxX = max(pMaxX, px)
            pMinY = min(pMinY, py)
            pMaxY = max(pMaxY, py)
        }
        val pcx = (pMinX + pMaxX) / 2
        val pcy = (pMinY + pMaxY) / 2
        val cx = acx + pcx * cos(rotation) - pcy * sin(rotation)
        val cy = acy + pcx * sin(rotation) + pcy * cos(rotation)
        return transform(cx, cy, pMaxX - pMinX, pMaxY - pMinY, rotation, -0.1f, 2.0f)
    }
}

internal class TimeSmoother(private val tauNanos: Long, private val deadZone: Float) {
    var x: Float = 0f
        private set
    var y: Float = 0f
        private set
    private var lastNanos = 0L
    private var initialized = false

    fun reset() {
        initialized = false
    }

    fun update(rawX: Float, rawY: Float, nowNanos: Long) {
        if (!initialized || tauNanos <= 0L) {
            x = rawX
            y = rawY
            lastNanos = nowNanos
            initialized = true
            return
        }
        val dt = (nowNanos - lastNanos).coerceAtLeast(0L)
        lastNanos = nowNanos
        val alpha = 1f - exp(-dt.toDouble() / tauNanos).toFloat()
        if (abs(rawX - x) >= deadZone) x += alpha * (rawX - x)
        if (abs(rawY - y) >= deadZone) y += alpha * (rawY - y)
    }
}

internal data class LandmarkConfig(
    val minPalmScore: Float = 0.5f,
    val minPresence: Float = 0.5f,
    val controlLandmark: Int = HandModelLayout.INDEX_TIP,
    val maxJumpFraction: Float = 0.35f,
    val identityMemoryNanos: Long = 2_000_000_000L,
    val smoothingTauNanos: Long = 100_000_000L,
    val deadZone: Float = 0.002f,
    val handednessSwitchUpdates: Int = 2,
    val maxPalmCandidates: Int = 4,
    val minRoiPixels: Float = 24f,
    val idleSearchHz: Float = 1.5f,
    val initialFastSearchNanos: Long = 3_000_000_000L,
    val fastSearchAfterLossNanos: Long = 2_000_000_000L,
    val maxConsecutiveBackendErrors: Int = 3,
) {
    init {
        require(controlLandmark in 0 until HandModelLayout.LANDMARKS) { "controlLandmark out of range" }
        require(maxPalmCandidates in 1..16) { "maxPalmCandidates must be in 1..16" }
        require(idleSearchHz > 0f) { "idleSearchHz must be positive" }
        require(maxConsecutiveBackendErrors >= 1) { "maxConsecutiveBackendErrors must be >= 1" }
    }
}

internal enum class LossReason { Presence, Region, WristJump, Handedness, BackendError }

internal data class LandmarkPoint(val x: Float, val y: Float, val confidence: Float, val acquired: Boolean)

/**
 * One-hand MediaPipe-style tracker: palm detection only to acquire, then landmark-only updates on
 * a region derived from the previous landmarks. A presence drop, a continuity break or a region
 * leaving the frame drops the track; the next update searches again and prefers the same hand.
 * Coordinates are camera-normalized (raw, unmirrored).
 */
internal class LandmarkHandTracker(
    private val backend: HandModelBackend,
    private val config: LandmarkConfig = LandmarkConfig(),
    private val events: ((String) -> Unit)? = null,
) : NativeFrameTracker {
    private val palms = FloatArray(HandModelLayout.PALM_STRIDE * 16)
    private val landmarks = FloatArray(HandModelLayout.LANDMARK_STRIDE)
    private val times = FloatArray(3)
    private val smoother = TimeSmoother(config.smoothingTauNanos, config.deadZone)
    private var roi: HandRoi? = null
    private var lastWristX = Float.NaN
    private var lastWristY = Float.NaN
    private var lastSeenNanos = Long.MIN_VALUE
    private var rightHand: Boolean? = null
    private var oppositeStreak = 0
    private var everTracked = false

    private val lossReasons = IntArray(LossReason.values().size)

    override var lossCount: Int = 0
        private set
    override var reacquisitions: Int = 0
        private set
    override var lastInferenceMs: Float = 0f
        private set
    var lastUpdateAcquired: Boolean = false
        private set
    override var lastUpdateSearched: Boolean = false
        private set
    override var backendErrors: Int = 0
        private set
    override var consecutiveBackendErrors: Int = 0
        private set
    override var lastBackendStatus: Int = 0
        private set

    override fun losses(reason: LossReason): Int = lossReasons[reason.ordinal]

    override val isTracking: Boolean
        get() = roi != null

    val isRightHand: Boolean?
        get() = rightHand

    fun reset() {
        roi = null
        rightHand = null
        oppositeStreak = 0
        lastSeenNanos = Long.MIN_VALUE
        smoother.reset()
    }

    override fun process(frame: ByteArray, width: Int, height: Int, nowNanos: Long): LandmarkPoint? {
        lastUpdateAcquired = false
        lastUpdateSearched = false
        val current = roi ?: return acquire(frame, width, height, nowNanos)
        times.fill(0f)
        val status = backend.landmarks(frame, width, height, current, landmarks, times)
        lastInferenceMs = times[1]
        if (!backendOk(status)) {
            loseTrack(LossReason.BackendError, "landmark inference failed (status $status)")
            return null
        }
        val presence = landmarks[0]
        if (presence < config.minPresence) {
            loseTrack(LossReason.Presence, "presence ${fmt(presence)} below ${fmt(config.minPresence)}")
            return null
        }
        val jump = wristJump(width)
        if (jump > config.maxJumpFraction) {
            loseTrack(LossReason.WristJump, "wrist moved ${fmt(jump)} of frame width (limit ${fmt(config.maxJumpFraction)})")
            return null
        }
        if (!updateHandedness(landmarks[1])) {
            loseTrack(LossReason.Handedness, "handedness ${fmt(landmarks[1])} opposite to locked ${if (rightHand == true) "right" else "left"} for ${config.handednessSwitchUpdates} updates")
            return null
        }
        if (!accept(width, height)) {
            loseTrack(LossReason.Region, "next region rejected (presence ${fmt(presence)})")
            return null
        }
        return publish(width, height, nowNanos, acquired = false)
    }

    private fun backendOk(status: Int): Boolean {
        lastBackendStatus = status
        if (status < 0) {
            backendErrors += 1
            consecutiveBackendErrors += 1
            return false
        }
        consecutiveBackendErrors = 0
        return true
    }

    private fun acquire(frame: ByteArray, width: Int, height: Int, nowNanos: Long): LandmarkPoint? {
        lastUpdateSearched = true
        times.fill(0f)
        val count = backend.detectPalms(frame, width, height, config.minPalmScore, palms, config.maxPalmCandidates, times)
        var inference = times[1]
        lastInferenceMs = inference
        if (!backendOk(count)) {
            events?.invoke("palm inference failed (status $count)")
            return null
        }
        if (count == 0) return null
        val remember = rightHand != null && nowNanos - lastSeenNanos <= config.identityMemoryNanos
        val order = candidateOrder(count, remember, width)
        val attempts = min(order.size, 2)
        for (attempt in 0 until attempts) {
            val candidate = RoiMath.fromPalm(palms, order[attempt] * HandModelLayout.PALM_STRIDE)
            times.fill(0f)
            val status = backend.landmarks(frame, width, height, candidate, landmarks, times)
            inference += times[1]
            lastInferenceMs = inference
            if (!backendOk(status)) {
                events?.invoke("landmark inference failed during acquisition (status $status)")
                return null
            }
            if (landmarks[0] < config.minPresence) continue
            val right = landmarks[1] > 0.5f
            val lastAttempt = attempt == attempts - 1
            if (remember && right != rightHand && !lastAttempt) continue
            roi = candidate
            if (!accept(width, height)) {
                roi = null
                continue
            }
            if (!remember || right != rightHand) rightHand = right
            oppositeStreak = 0
            if (everTracked) reacquisitions += 1
            everTracked = true
            smoother.reset()
            lastInferenceMs = inference
            lastUpdateAcquired = true
            events?.invoke("acquired ${if (rightHand == true) "right" else "left"} hand: palm ${fmt(palms[order[attempt] * HandModelLayout.PALM_STRIDE])} presence ${fmt(landmarks[0])} attempt ${attempt + 1}")
            return publish(width, height, nowNanos, acquired = true)
        }
        return null
    }

    private fun candidateOrder(count: Int, remember: Boolean, width: Int): IntArray {
        val order = IntArray(count) { it }
        if (!remember || lastWristX.isNaN()) return order
        val distance = FloatArray(count) { i ->
            val base = i * HandModelLayout.PALM_STRIDE + 5
            hypot(palms[base] - lastWristX, palms[base + 1] - lastWristY) / width
        }
        return order.sortedBy { distance[it] }.toIntArray()
    }

    private fun wristJump(width: Int): Float {
        if (lastWristX.isNaN()) return 0f
        val wx = landmarks[2 + HandModelLayout.WRIST * 2]
        val wy = landmarks[2 + HandModelLayout.WRIST * 2 + 1]
        return hypot(wx - lastWristX, wy - lastWristY) / width
    }

    private fun updateHandedness(score: Float): Boolean {
        val current = rightHand ?: return true
        val confident = abs(score - 0.5f) > 0.3f
        val right = score > 0.5f
        if (!confident || right == current) {
            oppositeStreak = 0
            return true
        }
        oppositeStreak += 1
        return oppositeStreak < config.handednessSwitchUpdates
    }

    private fun accept(width: Int, height: Int): Boolean {
        val next = RoiMath.fromLandmarks(landmarks, 2)
        if (next.size < config.minRoiPixels || next.cx < -next.size / 2 || next.cy < -next.size / 2 ||
            next.cx > width + next.size / 2 || next.cy > height + next.size / 2
        ) {
            return false
        }
        roi = next
        return true
    }

    private fun publish(width: Int, height: Int, nowNanos: Long, acquired: Boolean): LandmarkPoint {
        lastWristX = landmarks[2 + HandModelLayout.WRIST * 2]
        lastWristY = landmarks[2 + HandModelLayout.WRIST * 2 + 1]
        lastSeenNanos = nowNanos
        val cx = landmarks[2 + config.controlLandmark * 2] / width
        val cy = landmarks[2 + config.controlLandmark * 2 + 1] / height
        smoother.update(HandMapping.clamp01(cx), HandMapping.clamp01(cy), nowNanos)
        return LandmarkPoint(smoother.x, smoother.y, HandMapping.clamp01(landmarks[0]), acquired)
    }

    private fun loseTrack(reason: LossReason, detail: String) {
        roi = null
        oppositeStreak = 0
        lossCount += 1
        lossReasons[reason.ordinal] += 1
        events?.invoke("lost track: $reason - $detail")
    }

    private fun fmt(v: Float): String = String.format(Locale.US, "%.3f", v)
}
