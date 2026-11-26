// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Canvas
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView

internal class BooksNarrationViewport(
    context: Context,
    private val narrationScroll: ScrollView,
    private val narration: TextView,
    private val inlineSummary: TextView,
) : FrameLayout(context) {
    private val summaryScroll = ScrollView(context).apply {
        visibility = INVISIBLE
        isFillViewport = false
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        addView(inlineSummary, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    var onSummaryDrawn: (() -> Unit)? = null
    private var drawCallbackPending = false
    private val horizontalInset = dp(48)
    private val gap = dp(12)
    private val bottomInset = dp(8)

    init {
        addView(narrationScroll, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        addView(summaryScroll, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    fun setSummary(text: String?) {
        if (inlineSummary.text.toString() != text.orEmpty()) {
            inlineSummary.text = text.orEmpty()
            summaryScroll.scrollTo(0, 0)
            requestLayout()
        }
        if (text == null) summaryScroll.visibility = INVISIBLE
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        narrationScroll.measure(widthMeasureSpec, heightMeasureSpec)
        setMeasuredDimension(narrationScroll.measuredWidthAndState, narrationScroll.measuredHeightAndState)
        val width = narrationScroll.measuredWidth
        val height = narrationScroll.measuredHeight
        val summaryWidth = (width - 2 * horizontalInset).coerceAtLeast(0)
        val summaryHeight = (height - bottomInset - BooksSummaryPresentation.inlineTopPx(height)).coerceAtLeast(0)
        summaryScroll.measure(View.MeasureSpec.makeMeasureSpec(summaryWidth, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(summaryHeight, View.MeasureSpec.EXACTLY))
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val width = right - left
        val height = bottom - top
        if (narrationScroll.visibility != GONE) narrationScroll.layout(0, 0, width, height)
        val summaryTop = BooksSummaryPresentation.inlineTopPx(height)
        val summaryLeft = horizontalInset.coerceAtMost(width / 2)
        summaryScroll.layout(summaryLeft, summaryTop, summaryLeft + summaryScroll.measuredWidth,
            summaryTop + summaryScroll.measuredHeight)

        val textLayout = narration.layout
        val narrationBottom = if (textLayout == null || narrationScroll.visibility != VISIBLE) height
            else narration.top + narration.totalPaddingTop + textLayout.height + narration.compoundPaddingBottom
        val fits = BooksSummaryPresentation.inlineFits(height, narrationBottom, gap, bottomInset,
            inlineSummary.lineHeight + dp(4))
        summaryScroll.visibility = if (inlineSummary.text.isNotBlank() && summaryScroll.measuredWidth > 0 && fits)
            VISIBLE else INVISIBLE
    }

    fun summaryIsVisible(): Boolean = summaryScroll.visibility == VISIBLE && inlineSummary.isShown &&
        inlineSummary.getGlobalVisibleRect(Rect())

    fun setSummaryLongPress(action: (() -> Boolean)?) {
        inlineSummary.setOnLongClickListener(if (action == null) null else View.OnLongClickListener { action() })
        inlineSummary.isLongClickable = action != null
        inlineSummary.isClickable = false
    }

    override fun dispatchDraw(canvas: Canvas) {
        super.dispatchDraw(canvas)
        if (onSummaryDrawn != null && summaryIsVisible() && !drawCallbackPending) {
            drawCallbackPending = true
            post {
                drawCallbackPending = false
                if (summaryIsVisible()) onSummaryDrawn?.invoke()
            }
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
}
