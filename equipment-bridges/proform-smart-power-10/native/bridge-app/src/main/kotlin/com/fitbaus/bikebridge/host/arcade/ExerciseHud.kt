// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.arcade

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.fitbaus.arcade.FingerMathView
import com.fitbaus.arcade.FlakView
import com.fitbaus.arcade.PlaygroundView
import com.fitbaus.arcade.TrailRideView
import com.fitbaus.bikebridge.host.BridgeUiStateMapper

internal object HudPalette {
    val BACKGROUND: Int = Color.BLACK
    val LABEL: Int = Color.rgb(180, 180, 180)
    val MUTE: Int = Color.rgb(140, 140, 140)
    val RPM: Int = Color.rgb(255, 0, 255)
    val WATTS: Int = Color.rgb(0, 150, 255)
    val RESISTANCE: Int = Color.rgb(255, 140, 0)
    val HR: Int = Color.rgb(255, 40, 40)
}

internal object ExerciseHudFormat {
    const val UNKNOWN: String = BridgeUiStateMapper.GRID_UNKNOWN

    fun value(metric: Int?): String = metric?.toString() ?: UNKNOWN
}

/** Persistent exercise chrome kept by every future game: live RPM / Watts / Resistance / HR. */
internal class ExerciseHud(context: Context) : LinearLayout(context) {
    private val rpm: TextView
    private val watts: TextView
    private val resistance: TextView
    private val heartRate: TextView

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        rpm = addTile("RPM")
        watts = addTile("WATTS")
        resistance = addTile("RESISTANCE")
        heartRate = addTile("HR")
    }

    fun bind(
        rpmValue: Int?,
        wattsValue: Int?,
        resistanceValue: Int?,
        heartRateValue: Int?,
        heartRateFresh: Boolean = true,
    ) {
        show(rpm, rpmValue, HudPalette.RPM)
        show(watts, wattsValue, HudPalette.WATTS)
        show(resistance, resistanceValue, HudPalette.RESISTANCE)
        show(heartRate, heartRateValue, if (heartRateFresh) HudPalette.HR else HudPalette.MUTE)
    }

    private fun show(view: TextView, value: Int?, live: Int) {
        val text = ExerciseHudFormat.value(value)
        if (view.text.toString() != text) view.text = text
        val color = if (value != null) live else HudPalette.MUTE
        if (view.currentTextColor != color) view.setTextColor(color)
    }

    private fun addTile(caption: String): TextView {
        val tile = LinearLayout(context)
        tile.orientation = HORIZONTAL
        tile.gravity = Gravity.CENTER
        val value = TextView(context)
        value.text = ExerciseHudFormat.UNKNOWN
        value.textSize = 30f
        value.setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
        value.setTextColor(HudPalette.MUTE)
        value.includeFontPadding = false
        value.maxLines = 1
        tile.addView(value)
        val label = TextView(context)
        label.text = caption
        label.textSize = 12f
        label.setTypeface(Typeface.DEFAULT_BOLD, Typeface.NORMAL)
        label.setTextColor(HudPalette.LABEL)
        val labelLp = LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        labelLp.leftMargin = dp(8)
        tile.addView(label, labelLp)
        addView(tile, LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        return value
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
}

/** Arcade content: exercise HUD strip above the selected game. */
internal class ArcadeContent(context: Context) : LinearLayout(context) {
    val hud: ExerciseHud = ExerciseHud(context)
    val playground: PlaygroundView = PlaygroundView(context)
    val math: FingerMathView = FingerMathView(context)
    val flak: FlakView = FlakView(context)
    val trail: TrailRideView = TrailRideView(context)

    init {
        orientation = VERTICAL
        setBackgroundColor(HudPalette.BACKGROUND)
        addView(hud, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val playLp = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        playLp.topMargin = (8 * resources.displayMetrics.density + 0.5f).toInt()
        addView(playground, playLp)
        addView(math, LayoutParams(playLp))
        addView(flak, LayoutParams(playLp))
        addView(trail, LayoutParams(playLp))
        show(ArcadeMode.Bricks)
    }

    fun show(game: ArcadeMode) {
        playground.visibility = if (game == ArcadeMode.Bricks) VISIBLE else GONE
        math.visibility = if (game == ArcadeMode.Math) VISIBLE else GONE
        flak.visibility = if (game == ArcadeMode.Flak) VISIBLE else GONE
        trail.visibility = if (game == ArcadeMode.TrailRide) VISIBLE else GONE
    }
}
