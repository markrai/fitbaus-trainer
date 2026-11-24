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
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
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
    private val transcriberStore = TranscriberConnectionStore(context)
    private var books: BooksConnection? = null
    private val windows = ReadAlongWindowBuffer()
    private var localMode = false
    private data class Loaded(val local: BooksTranscriptLoad?, val remote: RemoteBooksWindow?)

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
    private val readingPrefs = context.applicationContext.getSharedPreferences("fitbaus_books_read_along", Context.MODE_PRIVATE)
    private var textSizeSp = readingPrefs.getInt("text_size_sp", 36).coerceIn(28, 52)
    private val fontSizeLabel = label("", 14f)
    private val fontSlider = SeekBar(context)
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
        fontSizeLabel.gravity = Gravity.CENTER
        fontSizeLabel.text = "Text: $textSizeSp"
        narration.textSize = textSizeSp.toFloat()
        fontSlider.max = 24
        fontSlider.progress = textSizeSp - 28
        fontSlider.contentDescription = "Narration text size"
        fontSlider.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                textSizeSp = progress + 28
                narration.textSize = textSizeSp.toFloat()
                fontSizeLabel.text = "Text: $textSizeSp"
                scroll.scrollTo(0, 0)
                readingPrefs.edit().putInt("text_size_sp", textSizeSp).apply()
            }

            override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
            override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
        })
        top.addView(fontSizeLabel, LayoutParams(dp(80), dp(48)))
        top.addView(fontSlider, LayoutParams(dp(176), dp(48)))
        addView(top, LayoutParams(MATCH, WRAP))
        status.gravity = Gravity.CENTER
        addView(status, LayoutParams(MATCH, WRAP))
        narration.gravity = Gravity.CENTER
        narration.setPadding(dp(12), dp(10), dp(12), dp(10))
        narration.setLineSpacing(dp(4).toFloat(), 1.12f)
        scroll.isFillViewport = true
        scroll.addView(narration, FrameLayout.LayoutParams(MATCH, WRAP))
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
        reload.setOnClickListener { reloadCurrent() }
        for (control in listOf(rewind, play, forward, reload)) {
            controls.addView(control, LayoutParams(0, dp(54), 1f))
        }
        addView(controls, LayoutParams(MATCH, WRAP))
        visibility = GONE
    }

    fun floatingNarration(): String? = if (visibility == VISIBLE) displayed ?: "Preparing narration…" else null

    fun open(next: BooksTranscriptRequest, state: BooksPlayerState, connection: BooksConnection) {
        if (destroyed) return
        close()
        request = next
        books = connection
        currentState = state
        visibility = VISIBLE
        render(state)
    }

    fun close() {
        generation++
        pending?.cancel(true)
        pending = null
        request = null
        books = null
        windows.clear()
        localMode = false
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
        val session = state.session
        if (ready && !localMode) {
            windows.plan(state.positionMs, session.durationMs, state.wantsPlay)?.let(::load)
        }
        val window = session?.let { windows.current(state.positionMs, it.durationMs) }
        val document = if (localMode) transcript else window?.transcript
        val failed = session != null && windows.failed(state.positionMs, session.durationMs)
        if (!localMode) {
            details.text = when {
                failed -> "Check Settings → Transcriber or tap Reload to retry."
                window != null -> "Remote Read Along"
                else -> ""
            }
        }
        reload.isEnabled = ready && (localMode || window != null || failed || pending == null)
        val text = when {
            document != null -> document.cueAt(state.positionMs)?.text ?: "…"
            localMode -> loadMessage
            failed -> "Narration unavailable. Audio continues."
            else -> "Preparing narration…"
        }
        if (text != displayed) {
            displayed = text
            narration.text = text
            scroll.scrollTo(0, 0)
        }
    }

    private fun reloadCurrent() {
        val session = currentState.session ?: return
        if (destroyed || currentState.failed) return
        localMode = false
        transcript = null
        load(windows.reload(currentState.positionMs, session.durationMs))
        render(currentState)
    }

    private fun load(target: ReadAlongWindowRequest) {
        val key = request ?: return
        val connection = books ?: return
        val session = currentState.session ?: return
        if (destroyed || currentState.failed) return
        val revision = windows.revision
        pending?.cancel(true)
        val ticket = ++generation
        windows.begin(target)
        pending = worker.submit {
            val result = runCatching {
                val paired = transcriberStore.load()
                if (paired == null) {
                    check(revision == null)
                    Loaded(source.load(key), null)
                } else {
                    Loaded(null, RemoteBooksTranscript(paired, connection).load(
                        key.itemId, session, target.startMs, revision, target.retry))
                }
            }
            main.post {
                if (ticket == generation && request == key && !destroyed) {
                    pending = null
                    result.fold(
                        onSuccess = { loaded ->
                            val remote = loaded.remote
                            if (remote != null) {
                                windows.complete(remote, currentState.positionMs, session.durationMs)
                            } else {
                                windows.clear()
                                localMode = true
                                transcript = loaded.local?.transcript
                                loadMessage = "No transcript available for this book."
                                details.text = if (transcript == null)
                                    loaded.local?.localPath?.let { "Local transcript: $it" }.orEmpty() else ""
                            }
                        },
                        onFailure = {
                            windows.fail(currentState.positionMs, session.durationMs)
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
