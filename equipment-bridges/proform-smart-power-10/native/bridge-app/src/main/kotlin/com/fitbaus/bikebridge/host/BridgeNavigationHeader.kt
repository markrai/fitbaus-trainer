// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.fitbaus.bikebridge.host.arcade.ArcadeMode

internal class BridgeNavigationHeader(
    private val context: Context,
    private val onSelectMode: (ArcadeMode) -> Unit,
    private val onOpenSettings: () -> Unit,
    private val onTrackerPicker: (ArcadeMode) -> Unit,
) {
    private val modeTabs = HashMap<ArcadeMode, TextView>()
    val view: View = buildTitleRow()

    fun render(mode: ArcadeMode) {
        for ((tabMode, tab) in modeTabs) styleTab(tab, tabMode == mode)
    }

    private fun styleTab(tab: TextView, selected: Boolean) {
        tab.setTextColor(if (selected) PRIMARY else MUTE)
        tab.setBackgroundColor(if (selected) DIVIDER else Color.TRANSPARENT)
    }

    private fun buildTitleRow(): View {
        val row = LinearLayout(context)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        val rowLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        rowLp.bottomMargin = dp(4)
        row.layoutParams = rowLp

        val brand = LinearLayout(context)
        brand.orientation = LinearLayout.HORIZONTAL
        brand.gravity = Gravity.CENTER_VERTICAL

        val title = label("FITBAUS", 16f, PRIMARY)
        title.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        title.letterSpacing = 0.18f
        title.includeFontPadding = false
        title.isLongClickable = true
        title.setOnLongClickListener {
            onOpenSettings()
            true
        }
        brand.addView(title, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val version = label(BridgeUiStateMapper.versionLabel(BuildConfig.VERSION_NAME), 11f, MUTE)
        version.includeFontPadding = false
        version.maxLines = 1
        version.isClickable = false
        version.isFocusable = false
        version.isLongClickable = false
        val versionLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        versionLp.leftMargin = dp(8)
        brand.addView(version, versionLp)

        row.addView(brand, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val tabs = LinearLayout(context)
        tabs.orientation = LinearLayout.HORIZONTAL
        tabs.gravity = Gravity.END or Gravity.CENTER_VERTICAL
        tabs.addView(tabGroup(ArcadeMode.Dashboard))
        val gamesLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        gamesLp.leftMargin = dp(GAME_TAB_GAP_DP)
        tabs.addView(tabGroup(ArcadeMode.Bricks, ArcadeMode.Math, ArcadeMode.Flak, ArcadeMode.TrailRide, ArcadeMode.GhoulRun, ArcadeMode.Biketris), gamesLp)
        val mediaLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        mediaLp.leftMargin = dp(GAME_TAB_GAP_DP)
        tabs.addView(tabGroup(ArcadeMode.YouTube, ArcadeMode.Books), mediaLp)
        val tabScroller = HorizontalScrollView(context)
        tabScroller.isFillViewport = true
        tabScroller.isHorizontalScrollBarEnabled = false
        tabScroller.addView(tabs, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val scrollerLp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        scrollerLp.leftMargin = dp(GAME_TAB_GAP_DP)
        row.addView(tabScroller, scrollerLp)

        val settingsLp = LinearLayout.LayoutParams(dp(SETTINGS_TOUCH_DP), dp(SETTINGS_TOUCH_DP))
        settingsLp.leftMargin = dp(GAME_TAB_GAP_DP)
        row.addView(settingsButton(), settingsLp)
        return row
    }

    private fun settingsButton(): ImageButton {
        val button = ImageButton(context)
        button.setImageResource(R.drawable.ic_settings)
        button.scaleType = ImageView.ScaleType.CENTER
        button.contentDescription = context.getString(R.string.open_bike_bridge_settings)
        val iconPad = dp((SETTINGS_TOUCH_DP - SETTINGS_ICON_DP) / 2)
        button.setPadding(iconPad, iconPad, iconPad, iconPad)
        button.background = settingsButtonBackground()
        button.isClickable = true
        button.isFocusable = true
        button.setOnClickListener { onOpenSettings() }
        return button
    }

    private fun settingsButtonBackground(): StateListDrawable {
        val pressed = GradientDrawable()
        pressed.setColor(DIVIDER)
        pressed.cornerRadius = dp(4).toFloat()
        val focused = GradientDrawable()
        focused.setColor(Color.rgb(64, 64, 64))
        focused.cornerRadius = dp(4).toFloat()
        val states = StateListDrawable()
        states.addState(intArrayOf(android.R.attr.state_pressed), pressed)
        states.addState(intArrayOf(android.R.attr.state_focused), focused)
        states.addState(intArrayOf(), ColorDrawable(Color.TRANSPARENT))
        return states
    }

    private fun tabGroup(vararg modes: ArcadeMode): LinearLayout {
        val group = LinearLayout(context)
        group.orientation = LinearLayout.HORIZONTAL
        val outline = GradientDrawable()
        outline.setStroke(dp(1), DIVIDER)
        outline.cornerRadius = dp(4).toFloat()
        group.background = outline
        group.setPadding(dp(1), dp(1), dp(1), dp(1))
        for (mode in modes) group.addView(modeTab(mode))
        return group
    }

    private fun modeTab(mode: ArcadeMode): TextView {
        val tab = label(mode.caption, 13f, MUTE)
        tab.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        tab.letterSpacing = 0.12f
        tab.gravity = Gravity.CENTER
        tab.setPadding(dp(16), dp(8), dp(16), dp(8))
        tab.isClickable = true
        tab.setOnClickListener { onSelectMode(mode) }
        if (mode.isGame) {
            tab.setOnLongClickListener {
                onTrackerPicker(mode)
                true
            }
        }
        modeTabs[mode] = tab
        return tab
    }

    private fun label(text: String, sizeSp: Float, color: Int): TextView {
        val view = TextView(context)
        view.text = text
        view.textSize = sizeSp
        view.setTextColor(color)
        return view
    }

    private fun dp(value: Int): Int = BridgeUiStateMapper.dp(value, context.resources.displayMetrics.density)

    private companion object {
        const val GAME_TAB_GAP_DP = 12
        const val SETTINGS_TOUCH_DP = 48
        const val SETTINGS_ICON_DP = 24
        val PRIMARY: Int = Color.WHITE
        val MUTE: Int = Color.rgb(140, 140, 140)
        val DIVIDER: Int = Color.rgb(48, 48, 48)
    }
}
