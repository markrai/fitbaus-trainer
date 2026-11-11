// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.fitbaus.bikebridge.protocol.BridgeHttpJson
import com.fitbaus.bikebridge.protocol.BridgeHttpRouter
import com.fitbaus.bikebridge.protocol.PairingToken

class PairingActivity : Activity() {
    private lateinit var endpointValue: TextView
    private lateinit var tokenValue: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        bind()
    }

    private fun bind() {
        endpointValue.text = "http://" + LanEndpointDisplay.format(BridgeHttpJson.DEFAULT_PORT)
        tokenValue.text = PairingToken.grouped(BridgeProcess.pairing(this).token())
    }

    private fun confirmRegenerate() {
        AlertDialog.Builder(this)
            .setTitle(R.string.pairing_regenerate_title)
            .setMessage(R.string.pairing_regenerate_message)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.pairing_regenerate) { _, _ ->
                BridgeProcess.pairing(this).regenerate()
                bind()
            }
            .show()
    }

    private fun buildUi(): View {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setBackgroundColor(Color.BLACK)
        val pad = dp(16)
        root.setPadding(pad, dp(10), pad, dp(10))

        val title = label("FITBAUS", 16f, Color.WHITE)
        title.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        title.letterSpacing = 0.18f
        root.addView(title, marginBottom(dp(4)))

        val rule = View(this)
        rule.setBackgroundColor(DIVIDER)
        val ruleLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
        ruleLp.topMargin = dp(8)
        ruleLp.bottomMargin = dp(8)
        root.addView(rule, ruleLp)

        val heading = label(getString(R.string.pairing_heading), 11f, MUTE)
        heading.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        heading.letterSpacing = 0.12f
        root.addView(heading, marginBottom(dp(4)))

        endpointValue = addRow(root, "ENDPOINT", 12f)
        addRow(root, "HEADER", 12f).text = BridgeHttpRouter.PAIRING_HEADER
        tokenValue = addRow(root, "TOKEN", 24f)

        val note = label(getString(R.string.pairing_note), 12f, MUTE)
        val noteLp = marginBottom(dp(16))
        noteLp.topMargin = dp(12)
        root.addView(note, noteLp)

        val buttons = LinearLayout(this)
        buttons.orientation = LinearLayout.HORIZONTAL
        buttons.gravity = Gravity.START
        val regenerate = Button(this)
        regenerate.setText(R.string.pairing_regenerate)
        regenerate.setOnClickListener { confirmRegenerate() }
        buttons.addView(regenerate)
        val done = Button(this)
        done.setText(R.string.pairing_done)
        done.setOnClickListener { finish() }
        val doneLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        doneLp.leftMargin = dp(16)
        buttons.addView(done, doneLp)
        root.addView(buttons)
        return root
    }

    private fun addRow(parent: LinearLayout, caption: String, valueSp: Float): TextView {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        val cap = label(caption, 12f, MUTE)
        cap.setTypeface(Typeface.DEFAULT_BOLD, Typeface.NORMAL)
        row.addView(cap, LinearLayout.LayoutParams(dp(108), ViewGroup.LayoutParams.WRAP_CONTENT))
        val value = label("", valueSp, Color.WHITE)
        value.setTypeface(Typeface.MONOSPACE, Typeface.NORMAL)
        value.setTextIsSelectable(true)
        row.addView(value, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        parent.addView(row, marginBottom(dp(2)))
        return value
    }

    private fun marginBottom(px: Int): LinearLayout.LayoutParams {
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        lp.bottomMargin = px
        return lp
    }

    private fun label(text: String, sizeSp: Float, color: Int): TextView {
        val view = TextView(this)
        view.text = text
        view.textSize = sizeSp
        view.setTextColor(color)
        return view
    }

    private fun dp(value: Int): Int = BridgeUiStateMapper.dp(value, resources.displayMetrics.density)

    private companion object {
        val MUTE: Int = Color.rgb(140, 140, 140)
        val DIVIDER: Int = Color.rgb(48, 48, 48)
    }
}
