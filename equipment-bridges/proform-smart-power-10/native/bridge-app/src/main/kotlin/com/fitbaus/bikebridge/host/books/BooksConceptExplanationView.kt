package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

internal class BooksConceptExplanationView(context: Context, private val onDismiss: () -> Unit) : ScrollView(context) {
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    private var downX = 0f
    private var downY = 0f
    private var moved = false
    private val heading = TextView(context).apply {
        textSize = 24f
        setTextColor(0xffffce1b.toInt())
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        setPadding(dp(16), dp(16), dp(16), dp(16))
        background = GradientDrawable().apply {
            setColor(0xff342b1e.toInt())
            cornerRadius = dp(12).toFloat()
        }
    }
    private val body = TextView(context).apply {
        textSize = 23f
        setTextColor(0xffeeeeee.toInt())
        setPadding(dp(4), dp(20), dp(4), dp(20))
        setLineSpacing(dp(4).toFloat(), 1f)
    }
    private val notice = TextView(context).apply {
        text = "AI-generated explanation · Tap anywhere to return"
        textSize = 14f
        setTextColor(0xffaaaaaa.toInt())
        gravity = Gravity.CENTER
    }

    init {
        isFillViewport = true
        setBackgroundColor(Color.BLACK)
        isClickable = true
        visibility = GONE
        addView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(16), dp(24), dp(16))
            addView(heading, LinearLayout.LayoutParams(-1, -2))
            addView(body, LinearLayout.LayoutParams(-1, -2))
            addView(notice, LinearLayout.LayoutParams(-1, -2))
        }, LayoutParams(-1, -2))
    }

    fun show(concept: String, state: ConceptExplanation) {
        val changed = heading.text.toString() != concept || visibility != VISIBLE
        heading.text = concept
        body.text = when (state) {
            ConceptExplanation.Loading -> "Preparing explanation…"
            ConceptExplanation.Unavailable -> "Explanation unavailable. Tap to return and double-tap the card to retry."
            is ConceptExplanation.Streaming -> state.text
            is ConceptExplanation.Incomplete -> state.text
            is ConceptExplanation.Ready -> state.text
        }
        notice.text = when (state) {
            is ConceptExplanation.Streaming -> "Generating… · Tap anywhere to return"
            is ConceptExplanation.Incomplete -> "Incomplete explanation · Return and double-tap to retry"
            else -> "AI-generated explanation · Tap anywhere to return"
        }
        visibility = VISIBLE
        if (changed) scrollTo(0, 0)
    }

    fun hide() {
        visibility = GONE
    }

    fun clear() {
        hide()
        heading.text = ""
        body.text = ""
        scrollTo(0, 0)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
                moved = false
            }
            MotionEvent.ACTION_MOVE, MotionEvent.ACTION_UP -> {
                val dx = event.x - downX
                val dy = event.y - downY
                if (dx * dx + dy * dy > touchSlop * touchSlop) moved = true
            }
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> moved = true
        }
        val handled = super.dispatchTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP && !moved &&
            event.eventTime - event.downTime < ViewConfiguration.getLongPressTimeout()) {
            performClick()
        }
        return handled || event.actionMasked == MotionEvent.ACTION_DOWN || event.actionMasked == MotionEvent.ACTION_UP
    }

    override fun performClick(): Boolean {
        super.performClick()
        onDismiss()
        return true
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
}
