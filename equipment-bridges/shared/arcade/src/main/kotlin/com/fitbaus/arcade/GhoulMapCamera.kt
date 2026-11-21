// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

internal class GhoulMapCamera {
    private var cosAngle = 0f
    private var sinAngle = 0f

    var quarter: Int? = null
        private set

    fun follow(yaw: Float) {
        val halfPi = (PI / 2).toFloat()
        val nearest = (yaw / halfPi).roundToInt()
        val snapped = nearest * halfPi
        quarter = if (abs(yaw - snapped) < 0.001f) ((nearest % 4) + 4) % 4 else null
        val angle = (if (quarter == null) yaw else snapped) - (PI / 4).toFloat()
        cosAngle = cos(angle)
        sinAngle = sin(angle)
    }

    fun x(row: Float, col: Float, tileWidth: Float): Float =
        (cosAngle * row - sinAngle * col) * tileWidth * INV_SQRT2

    fun y(row: Float, col: Float, tileHeight: Float): Float =
        -(cosAngle * col + sinAngle * row) * tileHeight * INV_SQRT2

    private companion object {
        const val INV_SQRT2 = 0.7071067811865476f
    }
}
