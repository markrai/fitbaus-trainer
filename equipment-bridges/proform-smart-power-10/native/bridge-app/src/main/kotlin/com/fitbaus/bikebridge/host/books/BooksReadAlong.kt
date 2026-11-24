// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal class BooksReadAlong(
    context: Context,
    onClose: () -> Unit,
    onToggle: () -> Unit,
    onSkip: (Long) -> Unit,
    private val source: BooksTranscriptSource = LocalBooksTranscriptSource(context),
) : LinearLayout(context) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val heading = label("", 18f)
    private val status = label("", 15f)
    private val narration = label("", 36f)
    private val details = label("", 14f)
    private val scroll = ScrollView(context)
    private val play = button("PAUSE")
    private val rewind = button("−30s")
    private val forward = button("+30s")
    private val reload = button("RELOAD")
    private val font = button("TEXT: 36")
    private val sizes = listOf(28f, 36f, 44f, 52f)
    private var sizeIndex = 1
    private var request: BooksTranscriptRequest? = null
    private var transcript: BooksTranscript? = null
    private var pending: Future<*>? = null
    private var generation = 0L
    private var displayed: String? = null
    private var currentState = BooksPlayerState()
    private var loadMessage = ""
    private var destroyed = false

    init {
        orientation = VERTICAL
        setPadding(dp(16), dp(4), dp(16), dp(8))
        setBackgroundColor(Color.BLACK)
        val top = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val back = button("‹ PLAYER")
        back.setOnClickListener { onClose() }
        heading.maxLines = 1
        heading.ellipsize = TextUtils.TruncateAt.END
        top.addView(back, LayoutParams(WRAP, dp(48)))
        top.addView(heading, LayoutParams(0, WRAP, 1f))
        top.addView(font, LayoutParams(WRAP, dp(48)))
        font.setOnClickListener {
            sizeIndex = (sizeIndex + 1) % sizes.size
            narration.textSize = sizes[sizeIndex]
            font.text = "TEXT: ${sizes[sizeIndex].toInt()}"
            scroll.scrollTo(0, 0)
        }
        addView(top, LayoutParams(MATCH, WRAP))
        status.gravity = Gravity.CENTER
        addView(status, LayoutParams(MATCH, WRAP))
        narration.gravity = Gravity.CENTER
        narration.setPadding(dp(12), dp(10), dp(12), dp(10))
        narration.setLineSpacing(dp(4).toFloat(), 1.12f)
        scroll.isFillViewport = true
        scroll.addView(narration, ScrollView.LayoutParams(MATCH, WRAP))
        addView(scroll, LayoutParams(MATCH, 0, 1f))
        details.setTextColor(Color.LTGRAY)
        details.setTextIsSelectable(true)
        details.maxLines = 3
        details.ellipsize = TextUtils.TruncateAt.END
        addView(details, LayoutParams(MATCH, WRAP))
        val controls = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER
        }
        play.setOnClickListener { onToggle() }
        rewind.setOnClickListener { onSkip(-30_000) }
        forward.setOnClickListener { onSkip(30_000) }
        reload.setOnClickListener { load() }
        for (control in listOf(rewind, play, forward, reload)) {
            controls.addView(control, LayoutParams(0, dp(54), 1f))
        }
        addView(controls, LayoutParams(MATCH, WRAP))
        visibility = GONE
    }

    fun open(next: BooksTranscriptRequest, state: BooksPlayerState) {
        if (destroyed) return
        close()
        request = next
        currentState = state
        visibility = VISIBLE
        load()
        render(state)
    }

    fun close() {
        generation++
        pending?.cancel(true)
        pending = null
        request = null
        transcript = null
        displayed = null
        loadMessage = ""
        currentState = BooksPlayerState()
        narration.text = ""
        details.text = ""
        visibility = GONE
    }

    fun destroy() {
        close()
        destroyed = true
        worker.shutdownNow()
    }

    fun render(state: BooksPlayerState) {
        if (visibility != VISIBLE) return
        currentState = state
        heading.text = state.item?.title.orEmpty()
        val seconds = state.positionMs.coerceAtLeast(0) / 1000
        status.text = String.format(Locale.US, "%d:%02d:%02d · %s", seconds / 3600, seconds / 60 % 60, seconds % 60, state.status)
        val ready = state.session != null && !state.failed
        play.isEnabled = ready
        rewind.isEnabled = ready
        forward.isEnabled = ready
        play.text = if (state.wantsPlay) "PAUSE" else "PLAY"
        val document = transcript
        val text = if (document == null) loadMessage else document.cueAt(state.positionMs)?.text ?: "…"
        if (text != displayed) {
            displayed = text
            narration.text = text
            scroll.scrollTo(0, 0)
        }
    }

    private fun load() {
        val key = request ?: return
        if (destroyed) return
        pending?.cancel(true)
        val ticket = ++generation
        transcript = null
        details.text = ""
        loadMessage = "Loading transcript…"
        reload.isEnabled = false
        render(currentState)
        pending = worker.submit {
            val result = runCatching { source.load(key) }
            main.post {
                if (ticket == generation && request == key && !destroyed) {
                    pending = null
                    reload.isEnabled = true
                    result.fold(
                        onSuccess = {
                            transcript = it.transcript
                            loadMessage = "No transcript available for this book."
                            details.text = if (it.transcript == null && it.localPath != null)
                                "Local transcript: ${it.localPath}" else ""
                        },
                        onFailure = {
                            loadMessage = "Could not read the transcript."
                            details.text = "Use a valid, timestamped WebVTT or SRT file."
                        },
                    )
                    render(currentState)
                }
            }
        }
    }

    private fun label(value: String, size: Float) = TextView(context).apply {
        text = value
        textSize = size
        setTextColor(Color.WHITE)
    }

    private fun button(value: String) = Button(context).apply { text = value }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

    private companion object {
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
    }
}
