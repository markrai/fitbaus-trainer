// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView

internal class BooksDiagramPanel(context: Context, close: () -> Boolean) : FrameLayout(context) {
    private val diagram = BooksDiagramView(context).apply { visibility = GONE }
    private val conceptView = BooksConceptView(context)
    private val canvas = ScrollView(context).apply {
        isFillViewport = true
        visibility = GONE
        addView(conceptView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    }
    private val indicator = ProgressBar(context).apply {
        isIndeterminate = true
        indeterminateTintList = ColorStateList.valueOf(0xffffce1b.toInt())
        visibility = GONE
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val message = TextView(context).apply {
        gravity = Gravity.CENTER
        textSize = 20f
        setTextColor(0xffbfbfbf.toInt())
        setPadding(dp(24), dp(12), dp(24), dp(12))
    }

    private val status = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        addView(indicator, LinearLayout.LayoutParams(dp(36), dp(36)))
        addView(message, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    }

    init {
        setBackgroundColor(Color.BLACK)
        visibility = GONE
        isClickable = true
        addView(diagram, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
            bottomMargin = dp(56)
        })
        addView(canvas, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
            bottomMargin = dp(56)
        })
        addView(status, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
            bottomMargin = dp(56)
        })
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
        if (state !is BooksDiagramState.Ready) {
            diagram.clearGraph()
            diagram.visibility = GONE
        }
        if (state !is BooksDiagramState.Concepts) {
            conceptView.clearConcepts()
            canvas.visibility = GONE
        }
        val rendered = when (state) {
            is BooksDiagramState.Ready -> try {
                diagram.showGraph(state.graph)
                diagram.visibility = VISIBLE
                true
            } catch (_: Exception) {
                diagram.clearGraph()
                diagram.visibility = GONE
                false
            }
            is BooksDiagramState.Concepts -> {
                if (conceptView.showConcepts(state.snippets)) canvas.scrollTo(0, 0)
                canvas.visibility = VISIBLE
                true
            }
            else -> false
        }
        val loading = state == BooksDiagramState.Loading
        indicator.visibility = if (loading) VISIBLE else GONE
        status.visibility = if (rendered) GONE else VISIBLE
        message.text = when {
            rendered -> ""
            loading -> "Preparing visual explanation…"
            else -> "Visual explanation unavailable"
        }
    }

    fun clear() {
        diagram.clearGraph()
        diagram.visibility = GONE
        conceptView.clearConcepts()
        canvas.visibility = GONE
        canvas.scrollTo(0, 0)
        message.text = ""
        indicator.visibility = GONE
        status.visibility = VISIBLE
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
}
