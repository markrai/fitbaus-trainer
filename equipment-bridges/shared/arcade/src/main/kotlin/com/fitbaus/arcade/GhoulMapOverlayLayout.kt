// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.min
import kotlin.math.roundToInt

internal enum class GhoulMapViewMode { Split, Overlay }

internal data class GhoulMapBounds(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
) {
    val width: Float get() = right - left
    val height: Float get() = bottom - top
}

internal object GhoulMapOverlayLayout {
    const val DEFAULT_WIDTH_SHARE = 0.38f
    const val DEFAULT_HEIGHT_SHARE = 0.58f
    const val MIN_WIDTH_SHARE = 0.36f
    const val MAX_WIDTH_SHARE = 1f
    const val MIN_HEIGHT_SHARE = 0.48f
    const val MAX_HEIGHT_SHARE = 1f
    const val DEFAULT_OPACITY = 40
    const val MIN_OPACITY = 20
    const val MAX_OPACITY = 80

    fun opacity(value: Int): Int = (value.coerceIn(MIN_OPACITY, MAX_OPACITY) / 10) * 10

    fun opacityAtFraction(fraction: Float): Int {
        val steps = (fraction.coerceIn(0f, 1f) * 6f).roundToInt()
        return MIN_OPACITY + steps * 10
    }

    fun bounds(
        screenWidth: Float,
        screenHeight: Float,
        headerHeight: Float,
        inset: Float,
        mode: GhoulMapViewMode,
        widthShare: Float = DEFAULT_WIDTH_SHARE,
        heightShare: Float = DEFAULT_HEIGHT_SHARE,
    ): GhoulMapBounds {
        val width = screenWidth.coerceAtLeast(1f)
        val height = screenHeight.coerceAtLeast(1f)
        val header = headerHeight.coerceIn(0f, height - 1f)
        if (mode == GhoulMapViewMode.Split) return GhoulMapBounds((width * 0.5f).roundToInt().toFloat(), header, width, height)
        val playable = height - header
        val margin = inset.coerceIn(0f, min(width, playable) * 0.1f)
        val selectedWidth = widthShare.coerceIn(MIN_WIDTH_SHARE, MAX_WIDTH_SHARE)
        val selectedHeight = heightShare.coerceIn(MIN_HEIGHT_SHARE, MAX_HEIGHT_SHARE)
        val rightInset = margin * ((MAX_WIDTH_SHARE - selectedWidth) /
            (MAX_WIDTH_SHARE - DEFAULT_WIDTH_SHARE)).coerceIn(0f, 1f)
        val topInset = margin * ((MAX_HEIGHT_SHARE - selectedHeight) /
            (MAX_HEIGHT_SHARE - DEFAULT_HEIGHT_SHARE)).coerceIn(0f, 1f)
        val mapWidth = (width * selectedWidth).coerceAtMost(width - rightInset)
        val mapHeight = (playable * selectedHeight).coerceAtMost(playable - topInset)
        val right = width - rightInset
        val top = header + topInset
        return GhoulMapBounds(right - mapWidth, top, right, top + mapHeight)
    }

    fun resizedShares(
        widthShare: Float,
        heightShare: Float,
        startWidth: Float,
        startHeight: Float,
        deltaX: Float,
        deltaY: Float,
        screenWidth: Float,
        playableHeight: Float,
    ): Pair<Float, Float> {
        if (screenWidth <= 0f || playableHeight <= 0f) return widthShare to heightShare
        val resizedWidth = ((startWidth - deltaX) / screenWidth).coerceIn(MIN_WIDTH_SHARE, MAX_WIDTH_SHARE)
        val resizedHeight = ((startHeight + deltaY) / playableHeight).coerceIn(MIN_HEIGHT_SHARE, MAX_HEIGHT_SHARE)
        return resizedWidth to resizedHeight
    }
}
