// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View

internal object VerticalSliderMath {
    fun valueAt(y: Float, top: Float, bottom: Float, max: Int): Int {
        if (max <= 0 || bottom <= top) return 0
        val fraction = ((bottom - y) / (bottom - top)).coerceIn(0f, 1f)
        return Math.round(fraction * max)
    }

    fun yFor(value: Int, top: Float, bottom: Float, max: Int): Float {
        if (max <= 0) return bottom
        val fraction = value.coerceIn(0, max).toFloat() / max
        return bottom - fraction * (bottom - top)
    }
}

internal class VerticalSlider(context: Context) : View(context) {
    var max: Int = 15
        set(value) {
            field = value.coerceAtLeast(1)
            progress = progress
            invalidate()
        }

    var progress: Int = 0
        set(value) {
            val clamped = value.coerceIn(0, max)
            if (clamped != field) {
                field = clamped
                invalidate()
            }
        }

    var onChange: ((Int) -> Unit)? = null

    var dragging: Boolean = false
        private set

    private val density = resources.displayMetrics.density
    private val trackWidth = 8f * density
    private val thumbRadius = 16f * density
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(64, 64, 64) }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(128, 203, 196) }
    private val thumb = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(128, 203, 196) }
    private val rect = RectF()

    init {
        isClickable = true
        isFocusable = true
    }

    private val trackTop: Float
        get() = paddingTop + thumbRadius

    private val trackBottom: Float
        get() = height - paddingBottom - thumbRadius

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val top = trackTop
        val bottom = trackBottom
        if (bottom <= top) return
        val y = VerticalSliderMath.yFor(progress, top, bottom, max)
        val radius = trackWidth / 2f
        rect.set(cx - radius, top, cx + radius, bottom)
        canvas.drawRoundRect(rect, radius, radius, track)
        rect.set(cx - radius, y, cx + radius, bottom)
        canvas.drawRoundRect(rect, radius, radius, fill)
        canvas.drawCircle(cx, y, thumbRadius, thumb)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!isEnabled) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragging = true
                parent?.requestDisallowInterceptTouchEvent(true)
                update(event.y)
            }
            MotionEvent.ACTION_MOVE -> update(event.y)
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                update(event.y)
                dragging = false
                if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
            }
            else -> return false
        }
        return true
    }

    override fun performClick(): Boolean = super.performClick()

    private fun update(y: Float) {
        val value = VerticalSliderMath.valueAt(y, trackTop, trackBottom, max)
        if (value != progress) {
            progress = value
            onChange?.invoke(value)
        }
    }
}
