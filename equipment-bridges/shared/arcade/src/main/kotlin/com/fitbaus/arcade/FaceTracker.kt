// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import java.util.Locale
import kotlin.math.hypot

internal data class FaceConfig(
    val minScore: Float = 0.6f,
    val maxFaces: Int = 4,
    val maxJumpFraction: Float = 0.35f,
    val smoothingTauNanos: Long = 80_000_000L,
    val deadZone: Float = 0.002f,
) {
    init {
        require(maxFaces in 1..8) { "maxFaces must be in 1..8" }
    }
}

internal class FaceTracker(
    private val backend: HandModelBackend,
    private val config: FaceConfig = FaceConfig(),
    private val events: ((String) -> Unit)? = null,
) : NativeFrameTracker {
    private val faces = FloatArray(HandModelLayout.FACE_STRIDE * 8)
    private val times = FloatArray(3)
    private val smoother = TimeSmoother(config.smoothingTauNanos, config.deadZone)
    private val lossReasons = IntArray(LossReason.values().size)
    private var lastX = Float.NaN
    private var lastY = Float.NaN
    private var everTracked = false

    override var isTracking: Boolean = false
        private set
    override var lastInferenceMs: Float = 0f
        private set
    override var lastUpdateSearched: Boolean = false
        private set
    override var lossCount: Int = 0
        private set
    override var reacquisitions: Int = 0
        private set
    override var backendErrors: Int = 0
        private set
    override var consecutiveBackendErrors: Int = 0
        private set
    override var lastBackendStatus: Int = 0
        private set

    override fun losses(reason: LossReason): Int = lossReasons[reason.ordinal]

    override fun process(frame: ByteArray, width: Int, height: Int, nowNanos: Long): LandmarkPoint? {
        lastUpdateSearched = !isTracking
        times.fill(0f)
        val count = backend.detectFaces(frame, width, height, config.minScore, faces, config.maxFaces, times)
        lastInferenceMs = times[1]
        lastBackendStatus = count
        if (count < 0) {
            backendErrors += 1
            consecutiveBackendErrors += 1
            if (isTracking) lose(LossReason.BackendError, "face inference failed (status $count)")
            else events?.invoke("face inference failed (status $count)")
            return null
        }
        consecutiveBackendErrors = 0
        if (count == 0) {
            if (isTracking) lose(LossReason.Presence, "no face detected")
            return null
        }
        val chosen = choose(count, width)
        val base = chosen * HandModelLayout.FACE_STRIDE
        val noseX = faces[base + 5 + HandModelLayout.FACE_NOSE * 2]
        val noseY = faces[base + 6 + HandModelLayout.FACE_NOSE * 2]
        if (isTracking && hypot(noseX - lastX, noseY - lastY) / width > config.maxJumpFraction) {
            lose(LossReason.WristJump, "face moved ${fmt(hypot(noseX - lastX, noseY - lastY) / width)} of frame width")
            return null
        }
        val acquired = !isTracking
        if (acquired) {
            isTracking = true
            if (everTracked) reacquisitions += 1
            everTracked = true
            smoother.reset()
            events?.invoke("acquired face: score ${fmt(faces[base])} box ${faces[base + 3].toInt()}px of $count")
        }
        lastX = noseX
        lastY = noseY
        smoother.update(HandMapping.clamp01(noseX / width), HandMapping.clamp01(noseY / height), nowNanos)
        return LandmarkPoint(smoother.x, smoother.y, HandMapping.clamp01(faces[base]), acquired)
    }

    private fun choose(count: Int, width: Int): Int {
        var best = 0
        if (isTracking && !lastX.isNaN()) {
            var bestDistance = Float.MAX_VALUE
            for (i in 0 until count) {
                val base = i * HandModelLayout.FACE_STRIDE + 5 + HandModelLayout.FACE_NOSE * 2
                val d = hypot(faces[base] - lastX, faces[base + 1] - lastY) / width
                if (d < bestDistance) {
                    bestDistance = d
                    best = i
                }
            }
            return best
        }
        var bestArea = -1f
        for (i in 0 until count) {
            val base = i * HandModelLayout.FACE_STRIDE
            val area = faces[base + 3] * faces[base + 4]
            if (area > bestArea) {
                bestArea = area
                best = i
            }
        }
        return best
    }

    private fun lose(reason: LossReason, detail: String) {
        isTracking = false
        lossCount += 1
        lossReasons[reason.ordinal] += 1
        events?.invoke("lost face: $reason - $detail")
    }

    private fun fmt(v: Float): String = String.format(Locale.US, "%.3f", v)
}
