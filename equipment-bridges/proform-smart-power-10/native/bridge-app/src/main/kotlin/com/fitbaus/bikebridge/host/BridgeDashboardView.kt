// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.fitbaus.bikebridge.protocol.BridgeHttpJson
import com.fitbaus.bikebridge.protocol.NativeTelemetrySnapshot

internal class BridgeDashboardView(context: Context) : LinearLayout(context) {
    private lateinit var rpmValue: TextView
    private lateinit var wattsValue: TextView
    private lateinit var resistanceValue: TextView
    private lateinit var hrValue: TextView
    private lateinit var statusValue: TextView
    private lateinit var usbValue: TextView
    private lateinit var initValue: TextView
    private lateinit var bikeValue: TextView
    private lateinit var controlValue: TextView
    private lateinit var requestedValue: TextView
    private lateinit var observedValue: TextView
    private lateinit var machineValue: TextView
    private lateinit var bridgeValue: TextView
    private lateinit var httpValue: TextView
    private val endpoint = DashboardEndpointState { LanEndpointDisplay.format(BridgeHttpJson.DEFAULT_PORT) }

    init {
        orientation = VERTICAL

        addView(
            buildStatGrid(),
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        val rule = View(context)
        rule.setBackgroundColor(DIVIDER)
        val ruleLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
        ruleLp.topMargin = dp(8)
        ruleLp.bottomMargin = dp(8)
        addView(rule, ruleLp)

        addView(buildDiagnostics())
    }

    fun bind(state: BridgeUiState, telemetry: NativeTelemetrySnapshot?, heartRate: HeartRateView?) {
        bindGridValue(rpmValue, BridgeUiStateMapper.currentValue(telemetry?.rpm), RPM_COLOR)
        bindGridValue(wattsValue, BridgeUiStateMapper.currentValue(telemetry?.watts), WATTS_COLOR)
        bindGridValue(resistanceValue, BridgeUiStateMapper.currentValue(telemetry?.resistance), RESISTANCE_COLOR)
        bindGridValue(hrValue, heartRate?.bpm, if (heartRate?.fresh == true) HR_COLOR else MUTE)
        setIfChanged(statusValue, BridgeUiStateMapper.statusRow(state))
        setIfChanged(usbValue, state.usbText)
        setIfChanged(initValue, state.initText)
        setIfChanged(bikeValue, BridgeUiStateMapper.bikeRow(telemetry))
        setIfChanged(controlValue, BridgeUiStateMapper.controlRow(telemetry))
        setIfChanged(requestedValue, BridgeUiStateMapper.formatGrid(telemetry?.requestedResistance))
        setIfChanged(observedValue, BridgeUiStateMapper.formatGrid(BridgeUiStateMapper.currentValue(telemetry?.resistance)))
        setIfChanged(machineValue, state.machineText)
        setIfChanged(bridgeValue, BridgeHttpJson.VERSION)
    }

    fun bindHttpEndpoint(force: Boolean, listening: Boolean?, error: String?) {
        setIfChanged(httpValue, endpoint.refresh(force, listening, error))
    }

    private fun bindGridValue(view: TextView, value: Int?, live: Int) {
        setIfChanged(view, BridgeUiStateMapper.formatGrid(value))
        val color = if (value != null) live else MUTE
        if (view.currentTextColor != color) view.setTextColor(color)
    }

    private fun setIfChanged(view: TextView, text: String) {
        if (view.text.toString() != text) view.text = text
    }

    private fun buildStatGrid(): View {
        val grid = LinearLayout(context)
        grid.orientation = LinearLayout.HORIZONTAL
        grid.gravity = Gravity.CENTER_VERTICAL

        val metrics = resources.displayMetrics
        @Suppress("DEPRECATION")
        val scaledDensity = metrics.scaledDensity
        val valueSp = BridgeUiStateMapper.gridValueSp(
            metrics.widthPixels,
            metrics.heightPixels,
            metrics.density,
            scaledDensity,
        )
        val labelSp = 16f
        rpmValue = addStatTile(grid, "RPM", valueSp, labelSp, true)
        wattsValue = addStatTile(grid, "WATTS", valueSp, labelSp, true)
        resistanceValue = addStatTile(grid, "RESISTANCE", valueSp, labelSp, true)
        hrValue = addStatTile(grid, "HR", valueSp, labelSp, false)
        return grid
    }

    private fun addStatTile(
        grid: LinearLayout,
        caption: String,
        valueSp: Float,
        labelSp: Float,
        showDivider: Boolean,
    ): TextView {
        val tile = LinearLayout(context)
        tile.orientation = LinearLayout.VERTICAL
        tile.gravity = Gravity.CENTER
        tile.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)

        val value = label(BridgeUiStateMapper.GRID_UNKNOWN, valueSp, MUTE)
        value.setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
        value.includeFontPadding = false
        value.gravity = Gravity.CENTER
        value.maxLines = 1
        tile.addView(value)

        val label = label(caption, labelSp, LABEL_COLOR)
        label.setTypeface(Typeface.DEFAULT_BOLD, Typeface.NORMAL)
        label.gravity = Gravity.CENTER_HORIZONTAL
        label.includeFontPadding = false
        val labelLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        labelLp.topMargin = dp(6)
        labelLp.gravity = Gravity.CENTER_HORIZONTAL
        tile.addView(label, labelLp)

        grid.addView(tile)

        if (showDivider) {
            val divider = View(context)
            divider.setBackgroundColor(DIVIDER)
            grid.addView(divider, LinearLayout.LayoutParams(dp(1), ViewGroup.LayoutParams.MATCH_PARENT))
        }

        return value
    }

    private fun buildDiagnostics(): View {
        val block = LinearLayout(context)
        block.orientation = LinearLayout.VERTICAL
        block.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )

        val heading = label("DIAGNOSTICS", 11f, MUTE)
        heading.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        heading.letterSpacing = 0.12f
        val headingLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        headingLp.bottomMargin = dp(4)
        heading.layoutParams = headingLp
        block.addView(heading)

        val columns = LinearLayout(context)
        columns.orientation = LinearLayout.HORIZONTAL

        val left = LinearLayout(context)
        left.orientation = LinearLayout.VERTICAL
        val right = LinearLayout(context)
        right.orientation = LinearLayout.VERTICAL
        left.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        val rightLp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        rightLp.leftMargin = dp(16)
        right.layoutParams = rightLp

        statusValue = addDiagRow(left, "STATUS")
        usbValue = addDiagRow(left, "USB")
        initValue = addDiagRow(left, "INIT")
        bikeValue = addDiagRow(left, "BIKE")
        controlValue = addDiagRow(left, "CONTROL")

        requestedValue = addDiagRow(right, "REQUESTED")
        observedValue = addDiagRow(right, "OBSERVED")
        machineValue = addDiagRow(right, "MACHINE")
        bridgeValue = addDiagRow(right, "BRIDGE")
        httpValue = addDiagRow(right, "HTTP")

        columns.addView(left)
        columns.addView(right)
        block.addView(columns)
        return block
    }

    private fun addDiagRow(column: LinearLayout, caption: String): TextView {
        val row = LinearLayout(context)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        val rowLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        rowLp.bottomMargin = dp(2)
        row.layoutParams = rowLp

        val cap = label(caption, 12f, MUTE)
        cap.setTypeface(Typeface.DEFAULT_BOLD, Typeface.NORMAL)
        cap.layoutParams = LinearLayout.LayoutParams(dp(108), ViewGroup.LayoutParams.WRAP_CONTENT)
        row.addView(cap)

        val value = label(BridgeUiStateMapper.GRID_UNKNOWN, 12f, PRIMARY)
        value.setTypeface(Typeface.MONOSPACE, Typeface.NORMAL)
        value.maxLines = 2
        row.addView(value, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        column.addView(row)
        return value
    }

    private fun label(text: String, sizeSp: Float, color: Int): TextView {
        val view = TextView(context)
        view.text = text
        view.textSize = sizeSp
        view.setTextColor(color)
        return view
    }

    private fun dp(value: Int): Int = BridgeUiStateMapper.dp(value, resources.displayMetrics.density)

    private companion object {
        val PRIMARY: Int = Color.WHITE
        val LABEL_COLOR: Int = Color.rgb(180, 180, 180)
        val MUTE: Int = Color.rgb(140, 140, 140)
        val DIVIDER: Int = Color.rgb(48, 48, 48)
        val RPM_COLOR: Int = Color.rgb(255, 0, 255)
        val WATTS_COLOR: Int = Color.rgb(0, 150, 255)
        val RESISTANCE_COLOR: Int = Color.rgb(255, 140, 0)
        val HR_COLOR: Int = Color.rgb(255, 40, 40)
    }
}
