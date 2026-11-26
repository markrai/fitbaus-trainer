package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.util.TypedValue
import android.view.View
import kotlin.math.ceil

internal class BooksConceptView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var snippets = emptyList<String>()
    private var labels = emptyList<StaticLayout>()
    private var geometry = ConceptLayout(0, emptyList())
    private var measuredForWidth = -1
    private var accentFlags = emptyList<Boolean>()

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        isFocusable = true
        setBackgroundColor(Color.BLACK)
    }

    fun showConcepts(value: List<String>): Boolean {
        if (snippets == value) return false
        snippets = value.toList()
        contentDescription = "Concepts. " + snippets.joinToString(". ")
        measuredForWidth = -1
        requestLayout()
        invalidate()
        return true
    }

    fun clearConcepts() {
        snippets = emptyList()
        labels = emptyList()
        accentFlags = emptyList()
        geometry = ConceptLayout(0, emptyList())
        measuredForWidth = -1
        contentDescription = null
        requestLayout()
        invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val available = MeasureSpec.getSize(widthMeasureSpec).coerceAtLeast(1)
        if (available != measuredForWidth) {
            rebuild(available)
            measuredForWidth = available
        }
        setMeasuredDimension(resolveSize(available, widthMeasureSpec),
            resolveSize(geometry.height + dp(40), heightMeasureSpec))
    }

    @Suppress("DEPRECATION")
    private fun rebuild(available: Int) {
        val inner = (available - dp(40)).coerceAtLeast(1)
        val horizontalPadding = dp(32).coerceAtMost(inner - 1)
        val maximum = (inner * 0.67f).toInt().coerceIn(1, inner)
        val textMax = (maximum - horizontalPadding).coerceAtLeast(1)
        accentFlags = snippets.map { it.codePointCount(0, it.length) <= 24 }
        labels = snippets.mapIndexed { index, value ->
            val length = value.codePointCount(0, value.length)
            val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                color = if (accentFlags[index]) 0xffffce1b.toInt() else 0xffeeeeee.toInt()
                textSize = sp(when {
                    length <= 24 -> 28f
                    length <= 65 -> 24f
                    else -> 20f
                })
                typeface = Typeface.create(if (accentFlags[index]) "sans-serif-medium" else "sans-serif", Typeface.NORMAL)
            }
            val width = ceil(Layout.getDesiredWidth(value, textPaint)).toInt().coerceIn(1, textMax)
            StaticLayout(value, textPaint, width, Layout.Alignment.ALIGN_CENTER, 1.08f, 0f, true)
        }
        val sizes = labels.map {
            ConceptSize((it.width + horizontalPadding).coerceIn(1, inner), maxOf(dp(58), it.height + dp(28)))
        }
        geometry = BooksConceptLayout.place(sizes, inner, dp(12).coerceAtMost(inner))
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val left = (width - (width - dp(40)).coerceAtLeast(1)) / 2f
        val top = maxOf(dp(20).toFloat(), (height - geometry.height) / 2f)
        canvas.save()
        canvas.translate(left, top)
        for (placed in geometry.placements) {
            val accent = accentFlags[placed.index]
            val bounds = RectF(placed.left.toFloat(), placed.top.toFloat(),
                (placed.left + placed.width).toFloat(), (placed.top + placed.height).toFloat())
            paint.style = Paint.Style.FILL
            paint.color = if (accent) 0xff282318.toInt() else 0xff1c1c1c.toInt()
            canvas.drawRoundRect(bounds, dp(16).toFloat(), dp(16).toFloat(), paint)
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = dp(1).toFloat()
            paint.color = if (accent) 0xff776428.toInt() else 0xff3d3d3d.toInt()
            canvas.drawRoundRect(bounds, dp(16).toFloat(), dp(16).toFloat(), paint)
            val label = labels[placed.index]
            canvas.save()
            canvas.translate(bounds.left + (bounds.width() - label.width) / 2f,
                bounds.top + (bounds.height() - label.height) / 2f)
            label.draw(canvas)
            canvas.restore()
        }
        canvas.restore()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
    private fun sp(value: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, resources.displayMetrics)
}
