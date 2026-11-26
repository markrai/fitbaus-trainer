// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView

internal class BooksDiagramPanel(context: Context, close: () -> Boolean) : FrameLayout(context) {
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
        message.text = when (state) {
            BooksDiagramState.Loading -> "Preparing visual explanation…"
            BooksDiagramState.Unavailable -> "Visual explanation unavailable"
            is BooksDiagramState.Ready -> "Visual explanation ready. Rendering is not available in this build."
        }
    }

    fun clear() { message.text = "" }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
}
