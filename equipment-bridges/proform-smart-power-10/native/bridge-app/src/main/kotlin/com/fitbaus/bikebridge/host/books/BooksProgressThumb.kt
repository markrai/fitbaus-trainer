// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.res.Resources
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import kotlin.math.roundToInt

internal fun bookPlaybackPercent(progress: Int, max: Int): Int =
    if (max <= 0) 0 else (progress.coerceIn(0, max).toLong() * 100 / max).toInt()

internal class BooksProgressThumb(resources: Resources) : Drawable() {
    private val density = resources.displayMetrics.density
    private val diameter = (30 * density).roundToInt().coerceAtLeast(1)
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.create("sans-serif", Typeface.BOLD)
        textAlign = Paint.Align.CENTER
        textSize = 10 * resources.displayMetrics.scaledDensity
        val available = diameter - 4 * density
        if (measureText("100%") > available) textSize *= available / measureText("100%")
    }
    private var percent = 0
    private var percentageText = "0%"
    private var paintAlpha = 255
    private var enabled = true

    fun updateProgress(progress: Int, max: Int) {
        val value = bookPlaybackPercent(progress, max)
        if (percent == value) return
        percent = value
        percentageText = "$value%"
        invalidateSelf()
    }

    override fun getIntrinsicWidth(): Int = diameter
    override fun getIntrinsicHeight(): Int = diameter

    override fun draw(canvas: Canvas) {
        val x = bounds.exactCenterX()
        val y = bounds.exactCenterY()
        fill.color = if (enabled) 0xffffce1b.toInt() else 0xff42474e.toInt()
        fill.alpha = paintAlpha
        canvas.drawCircle(x, y, minOf(bounds.width(), bounds.height()) / 2f, fill)
        label.color = if (enabled) Color.BLACK else 0xffb0b5bd.toInt()
        label.alpha = paintAlpha
        val metrics = label.fontMetrics
        canvas.drawText(percentageText, x, y - (metrics.ascent + metrics.descent) / 2f, label)
    }

    override fun isStateful(): Boolean = true

    override fun onStateChange(state: IntArray): Boolean {
        val next = android.R.attr.state_enabled in state
        if (next == enabled) return false
        enabled = next
        invalidateSelf()
        return true
    }

    override fun setAlpha(alpha: Int) {
        paintAlpha = alpha
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        fill.colorFilter = colorFilter
        label.colorFilter = colorFilter
        invalidateSelf()
    }

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
