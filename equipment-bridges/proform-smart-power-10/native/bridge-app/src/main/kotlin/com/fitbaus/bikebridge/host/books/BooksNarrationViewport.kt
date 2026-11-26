// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
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
        visibility = GONE
        isFillViewport = false
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        addView(inlineSummary, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
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
        summaryScroll.visibility = if (text == null) GONE else VISIBLE
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        narrationScroll.measure(widthMeasureSpec, heightMeasureSpec)
        setMeasuredDimension(narrationScroll.measuredWidthAndState, narrationScroll.measuredHeightAndState)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val width = right - left
        val height = bottom - top
        if (narrationScroll.visibility != GONE) narrationScroll.layout(0, 0, width, height)
        if (summaryScroll.visibility == GONE) return

        val textLayout = narration.layout
        val narrationBottom = if (textLayout == null || narrationScroll.visibility != VISIBLE) height
            else narration.top + narration.totalPaddingTop + textLayout.height + narration.compoundPaddingBottom
        val summaryTop = BooksSummaryPresentation.inlineTopPx(height, narrationBottom, gap, bottomInset,
            inlineSummary.lineHeight + dp(4))
        val summaryWidth = (width - 2 * horizontalInset).coerceAtLeast(0)
        val summaryHeight = if (summaryTop == null || summaryWidth == 0) 0 else height - bottomInset - summaryTop
        val y = summaryTop ?: height
        summaryScroll.measure(View.MeasureSpec.makeMeasureSpec(summaryWidth, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(summaryHeight, View.MeasureSpec.EXACTLY))
        summaryScroll.layout(horizontalInset, y, horizontalInset + summaryWidth, y + summaryHeight)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
}
