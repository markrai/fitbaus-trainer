// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.cos
import kotlin.math.sin

internal enum class Pose { Extended, Folded, Partial, Ambiguous }

internal object SyntheticHands {
    private val mcp = arrayOf(floatArrayOf(-0.22f, -0.62f), floatArrayOf(0f, -0.64f), floatArrayOf(0.18f, -0.6f), floatArrayOf(0.33f, -0.52f))

    fun open(): Array<Pose> = Array(5) { Pose.Extended }

    fun fist(): Array<Pose> = Array(5) { Pose.Folded }

    fun showing(count: Int): Array<Pose> = Array(5) { if (it < count) Pose.Extended else Pose.Folded }

    fun fromMask(mask: Int): Array<Pose> = Array(5) { if (mask and (1 shl it) != 0) Pose.Extended else Pose.Folded }

    fun points(
        poses: Array<Pose>,
        wristX: Float,
        wristY: Float,
        scale: Float = 100f,
        degrees: Float = 0f,
        mirrored: Boolean = false,
    ): FloatArray {
        val local = FloatArray(HandModelLayout.LANDMARKS * 2)
        fun set(i: Int, x: Float, y: Float) {
            local[i * 2] = x
            local[i * 2 + 1] = y
        }
        set(0, 0f, 0f)
        set(1, -0.3f, -0.15f)
        set(2, -0.45f, -0.35f)
        when (poses[0]) {
            Pose.Extended -> {
                set(3, -0.6f, -0.5f)
                set(4, -0.75f, -0.65f)
            }
            Pose.Folded -> {
                set(3, -0.35f, -0.5f)
                set(4, -0.1f, -0.5f)
            }
            Pose.Partial, Pose.Ambiguous -> {
                set(3, -0.5f, -0.48f)
                set(4, -0.5f, -0.58f)
            }
        }
        for (f in 0 until 4) {
            val base = 5 + f * 4
            val mx = mcp[f][0]
            val my = mcp[f][1]
            set(base, mx, my)
            when (poses[f + 1]) {
                Pose.Extended -> {
                    set(base + 1, mx, my - 0.28f)
                    set(base + 2, mx, my - 0.44f)
                    set(base + 3, mx, my - 0.58f)
                }
                Pose.Folded -> {
                    set(base + 1, mx, my - 0.25f)
                    set(base + 2, mx, my - 0.12f)
                    set(base + 3, mx, my + 0.06f)
                }
                Pose.Partial, Pose.Ambiguous -> {
                    set(base + 1, mx, my - 0.26f)
                    set(base + 2, mx + 0.07f, my - 0.31f)
                    set(base + 3, mx + 0.12f, my - 0.32f)
                }
            }
        }
        val out = FloatArray(local.size)
        val r = Math.toRadians(degrees.toDouble())
        val c = cos(r).toFloat()
        val s = sin(r).toFloat()
        for (i in 0 until HandModelLayout.LANDMARKS) {
            val x = local[i * 2] * (if (mirrored) -1f else 1f)
            val y = local[i * 2 + 1]
            out[i * 2] = wristX + (x * c - y * s) * scale
            out[i * 2 + 1] = wristY + (x * s + y * c) * scale
        }
        return out
    }

    fun landmarks(points: FloatArray, presence: Float = 0.98f): FloatArray {
        val out = FloatArray(HandModelLayout.LANDMARK_STRIDE)
        out[0] = presence
        out[1] = 1f
        System.arraycopy(points, 0, out, 2, points.size)
        return out
    }
}

internal class SceneHand(val points: FloatArray, val presence: Float = 0.98f, val palmScore: Float = 0.9f) {
    val wristX: Float
        get() = points[0]
    val wristY: Float
        get() = points[1]
}

internal fun FakeHandModels.show(vararg hands: SceneHand) {
    palms = hands.map { HandShapes.palm(it.palmScore, it.wristX, it.wristY) }
    responder = { roi ->
        val nearest = hands.minByOrNull { kotlin.math.hypot(it.wristX - roi.cx, it.wristY - roi.cy) }
        when {
            nearest == null -> SyntheticHands.landmarks(SyntheticHands.points(SyntheticHands.fist(), roi.cx, roi.cy), presence = 0.02f)
            kotlin.math.hypot(nearest.wristX - roi.cx, nearest.wristY - roi.cy) > 150f ->
                SyntheticHands.landmarks(SyntheticHands.points(SyntheticHands.fist(), roi.cx, roi.cy), presence = 0.02f)
            else -> SyntheticHands.landmarks(nearest.points, nearest.presence)
        }
    }
}

internal fun observation(sequence: Long, atMs: Long, vararg counts: Pair<Int, Int?>, rejection: FingerRejection? = null): FingerObservation {
    val hands = counts.mapIndexed { i, (id, count) ->
        val poses = if (count == null) Array(5) { Pose.Partial } else SyntheticHands.showing(count)
        val pts = SyntheticHands.points(poses, 500f - i * 300f, 400f)
        ObservedHand(id, FingerClassifier.classify(pts), 0.98f, pts[0], pts[1], pts)
    }
    val reason = rejection ?: when {
        hands.isEmpty() -> FingerRejection.NoHands
        hands.size == 1 -> FingerRejection.OneHand
        hands.any { it.count == null } -> FingerRejection.Uncertain
        else -> null
    }
    return FingerObservation(sequence, atMs * 1_000_000L, 640, 480, hands, reason, 0)
}
