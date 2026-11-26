// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView

internal class BooksDiagramPanel(context: Context, close: () -> Boolean) : FrameLayout(context) {
    private val diagram = BooksDiagramView(context).apply { visibility = GONE }
    private val message = TextView(context).apply {
        gravity = Gravity.CENTER
        textSize = 20f
        setTextColor(0xffbfbfbf.toInt())
        setPadding(dp(24), dp(24), dp(24), dp(24))
    }

    init {
        setBackgroundColor(Color.BLACK)
        visibility = GONE
        isClickable = true
        addView(diagram, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
            bottomMargin = dp(56)
        })
        addView(message, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        val dismiss = Button(context).apply {
            text = "×"
            textSize = 30f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.TRANSPARENT)
            stateListAnimator = null
            elevation = 0f
            contentDescription = "Close visual explanation"
            setOnClickListener { close() }
        }
        addView(dismiss, LayoutParams(dp(56), dp(56), Gravity.BOTTOM or Gravity.RIGHT))
    }

    fun render(state: BooksDiagramState) {
        if (state is BooksDiagramState.Ready) {
            val rendered = try {
                diagram.showGraph(state.graph)
                true
            } catch (_: Exception) {
                false
            }
            diagram.visibility = if (rendered) VISIBLE else GONE
            message.visibility = if (rendered) GONE else VISIBLE
            message.text = if (rendered) "" else "Visual explanation unavailable"
            if (!rendered) diagram.clearGraph()
        } else {
            diagram.clearGraph()
            diagram.visibility = GONE
            message.visibility = VISIBLE
            message.text = if (state == BooksDiagramState.Loading) "Preparing visual explanation…" else "Visual explanation unavailable"
        }
    }

    fun clear() {
        diagram.clearGraph()
        diagram.visibility = GONE
        message.text = ""
        message.visibility = VISIBLE
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
}
