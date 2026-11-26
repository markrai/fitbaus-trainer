package com.fitbaus.bikebridge.host.ui

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

internal class NativeDialogViews(
    private val context: Context,
    private val style: NativeDialogStyle,
) {
    fun dp(value: Int): Int = dialogDp(value, context.resources.displayMetrics.density)

    fun surface(fill: Int, stroke: Int, width: Int = 1) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(style.cornerDp).toFloat()
        setStroke(dp(width), stroke)
    }

    fun label(
        parent: LinearLayout,
        value: String,
        size: Float,
        color: Int,
        bold: Boolean = false,
        fullWidth: Boolean = true,
    ): TextView = TextView(context).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        setPadding(0, dp(style.labelTopDp), 0, dp(style.labelBottomDp))
        parent.addView(this, LinearLayout.LayoutParams(if (fullWidth) -1 else -2, -2))
    }

    fun button(
        parent: LinearLayout,
        value: String,
        enabled: Boolean = true,
        primary: Boolean = false,
        index: Int = -1,
        retainOpacity: Boolean = false,
        action: () -> Unit,
    ): Button = Button(context).apply {
        text = value
        style.buttonTextSp?.let { textSize = it }
        isEnabled = enabled
        setTextColor(if (primary) Color.BLACK else Color.WHITE)
        alpha = style.buttonAlpha(enabled, retainOpacity)
        background = surface(if (primary) style.accent else style.buttonFill,
            if (primary) style.accent else style.buttonBorder)
        setOnClickListener { action() }
        val layout = style.buttonLayout(parent.orientation == LinearLayout.HORIZONTAL)
        parent.addView(this, index, LinearLayout.LayoutParams(layout.width, dp(layout.heightDp), layout.weight).apply {
            setMargins(dp(layout.sideDp), dp(layout.topDp), dp(layout.sideDp), dp(layout.bottomDp))
        })
    }
}

internal fun setDialogTreeEnabled(view: View, enabled: Boolean) {
    view.isEnabled = enabled
    if (view is ViewGroup) {
        for (i in 0 until view.childCount) setDialogTreeEnabled(view.getChildAt(i), enabled)
    }
}
