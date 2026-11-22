// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.hypot

internal object GhoulEyeArt {
    const val LEFT_U = 0.507f
    const val RIGHT_U = 0.526f
    const val EYE_V = 0.158f
    const val CORE_U = 0.006f
    const val CORE_V = 0.011f
    const val HALO_U = 0.013f
    const val HALO_V = 0.023f

    fun glowAt(u: Float, v: Float, stunned: Boolean = false): Float {
        if (stunned) return 0f
        fun spot(cx: Float, rx: Float, ry: Float): Float {
            val d = hypot((u - cx) / rx, (v - EYE_V) / ry)
            val t = ((d - 0.30f) / 0.70f).coerceIn(0f, 1f)
            return 1f - t * t * (3f - 2f * t)
        }
        val core = maxOf(spot(LEFT_U, CORE_U, CORE_V), spot(RIGHT_U, CORE_U, CORE_V))
        val halo = maxOf(spot(LEFT_U, HALO_U, HALO_V), spot(RIGHT_U, HALO_U, HALO_V))
        return (core + halo * 0.4f).coerceIn(0f, 1f)
    }
}

internal object GhoulDarkness {
    fun ambient(lampRadius: Float): Float = (lampRadius / 6f).coerceIn(0f, 1f)
}
