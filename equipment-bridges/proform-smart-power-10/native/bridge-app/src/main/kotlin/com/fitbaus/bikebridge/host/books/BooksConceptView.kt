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
    private var styles = emptyList<ConceptCardStyle>()
    private var metrics = emptyList<ConceptCardMetrics>()
    private var stroke = 0

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        isFocusable = true
        setBackgroundColor(Color.BLACK)
    }

    fun showConcepts(value: List<String>): Boolean {
        if (snippets == value) return false
        snippets = value.toList()
        styles = BooksConceptStyles.assign(snippets)
        labels = emptyList()
        metrics = emptyList()
        geometry = ConceptLayout(0, emptyList())
        contentDescription = "Concepts. " + snippets.joinToString(". ")
        measuredForWidth = -1
        requestLayout()
        invalidate()
        return true
    }

    fun clearConcepts() {
        snippets = emptyList()
        labels = emptyList()
        styles = emptyList()
        metrics = emptyList()
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
        stroke = if (inner > 1) dp(1).coerceIn(1, inner - 1) else 0
        val gap = dp(16).coerceAtMost(inner)
        val maximum = if (snippets.size > 1 && inner >= dp(440)) {
            minOf((inner * 0.46f).toInt(), (inner - gap) / 2 - stroke).coerceIn(1, inner - stroke)
        } else {
            (inner * 0.67f).toInt().coerceIn(1, inner - stroke)
        }
        val padding = styles.map { dp(it.horizontalPaddingDp).coerceAtMost(maximum - 1) }
        labels = snippets.mapIndexed { index, value ->
            val style = styles[index]
            val short = value.codePointCount(0, value.length) <= 24
            val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                color = if (short) style.palette.accent else 0xffeeeeee.toInt()
                textSize = sp(style.fontSp)
                typeface = Typeface.create(if (short) "sans-serif-medium" else "sans-serif", Typeface.NORMAL)
            }
            val textMax = (maximum - padding[index]).coerceAtLeast(1)
            val width = ceil(Layout.getDesiredWidth(value, textPaint)).toInt().coerceIn(1, textMax)
            StaticLayout(value, textPaint, width, Layout.Alignment.ALIGN_CENTER, 1.08f, 0f, true)
        }
        metrics = labels.mapIndexed { index, label ->
            val style = styles[index]
            val size = ConceptSize(label.width + padding[index], maxOf(dp(58), label.height + dp(style.verticalPaddingDp)))
            BooksConceptStyles.metrics(size, inner, stroke)
        }
        geometry = BooksConceptLayout.place(metrics.map { it.footprint }, inner, gap,
            stagger = dp(20), seed = snippets.hashCode())
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val left = (width - (width - dp(40)).coerceAtLeast(1)) / 2f
        val top = maxOf(dp(20).toFloat(), (height - geometry.height) / 2f)
        canvas.save()
        canvas.translate(left, top)
        for (placed in geometry.placements) {
            val style = styles[placed.index]
            val card = metrics[placed.index]
            val centerX = placed.left + placed.width / 2f
            val centerY = placed.top + placed.height / 2f
            val bounds = RectF(centerX - card.body.width / 2f, centerY - card.body.height / 2f,
                centerX + card.body.width / 2f, centerY + card.body.height / 2f)
            val radius = dp(style.radiusDp).toFloat()
            canvas.save()
            paint.style = Paint.Style.FILL
            paint.color = style.palette.fill
            canvas.drawRoundRect(bounds, radius, radius, paint)
            if (stroke > 0) {
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = stroke.toFloat()
                paint.color = style.palette.border
                canvas.drawRoundRect(bounds, radius, radius, paint)
            }
            val label = labels[placed.index]
            canvas.translate(centerX - label.width / 2f, centerY - label.height / 2f)
            label.draw(canvas)
            canvas.restore()
        }
        canvas.restore()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
    private fun sp(value: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, resources.displayMetrics)
}
