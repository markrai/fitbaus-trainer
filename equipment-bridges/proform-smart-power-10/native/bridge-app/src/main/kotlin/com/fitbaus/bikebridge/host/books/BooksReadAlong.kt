// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class BooksReadAlong(
    context: Context,
    private val source: BooksTranscriptSource = LocalBooksTranscriptSource(context),
    onFullscreenRequested: () -> Unit = {},
) : LinearLayout(context) {
    private val transcriberStore = TranscriberConnectionStore(context)
    private var books: BooksConnection? = null
    private val windows = ReadAlongWindowBuffer()
    private var localMode = false
    private data class Loaded(val local: BooksTranscriptLoad?, val remote: RemoteBooksWindow?)

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val summaryWorker = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, LinkedBlockingQueue<Runnable>(1))
    private val summaryScope = BooksSummaryScope()
    private var summaryFuture: Future<*>? = null
    private var summaryCallback: ((BooksSummaryState) -> Unit)? = null
    private val narration = label("", 36f)
    private val details = label("", 14f)
    private val scroll = ScrollView(context)
    private val reload = button("RETRY NARRATION")
    val cover = ImageView(context)
    private val readingControls = LinearLayout(context)
    private val footer = LinearLayout(context)
    private val fullscreenButton = NarrationFullscreenButton(context)
    private var fullscreen = false
    private var hasNarration = false
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
    private var destroyed = false

    init {
        orientation = VERTICAL
        setPadding(dp(16), dp(4), dp(16), dp(8))
        setBackgroundColor(Color.BLACK)
        readingControls.orientation = HORIZONTAL
        readingControls.gravity = Gravity.CENTER_VERTICAL
        readingControls.visibility = GONE
        val readingLabel = label("Read along", 16f)
        readingControls.addView(readingLabel, LayoutParams(0, WRAP, 1f))
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
        readingControls.addView(fontSizeLabel, LayoutParams(dp(80), dp(40)))
        readingControls.addView(fontSlider, LayoutParams(dp(176), dp(40)))
        addView(readingControls, LayoutParams(MATCH, WRAP))
        narration.gravity = Gravity.CENTER
        narration.setPadding(dp(12), dp(6), dp(12), dp(6))
        narration.setLineSpacing(dp(4).toFloat(), 1.12f)
        scroll.isFillViewport = true
        scroll.addView(narration, FrameLayout.LayoutParams(MATCH, WRAP))
        cover.scaleType = ImageView.ScaleType.FIT_CENTER
        cover.contentDescription = "Audiobook cover"
        val stage = FrameLayout(context)
        stage.addView(cover, FrameLayout.LayoutParams(MATCH, MATCH))
        stage.addView(scroll, FrameLayout.LayoutParams(MATCH, MATCH))
        fullscreenButton.visibility = GONE
        fullscreenButton.contentDescription = "Enter fullscreen narration"
        fullscreenButton.setOnClickListener { onFullscreenRequested() }
        stage.addView(fullscreenButton, FrameLayout.LayoutParams(dp(48), dp(48), Gravity.BOTTOM or Gravity.RIGHT))
        scroll.visibility = GONE
        addView(stage, LayoutParams(MATCH, 0, 1f))
        footer.apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        details.setTextColor(Color.LTGRAY)
        details.maxLines = 2
        details.ellipsize = TextUtils.TruncateAt.END
        footer.addView(details, LayoutParams(0, WRAP, 1f))
        reload.setOnClickListener { reloadCurrent() }
        reload.visibility = GONE
        footer.addView(reload, LayoutParams(WRAP, dp(44)))
        addView(footer, LayoutParams(MATCH, WRAP))
        visibility = GONE
    }

    fun canEnterFullscreen(): Boolean = visibility == VISIBLE && hasNarration

    fun setFullscreen(value: Boolean) {
        if (fullscreen == value) return
        fullscreen = value
        if (!value) cancelSummary()
        fullscreenButton.expanded = value
        fullscreenButton.contentDescription = if (value) "Exit fullscreen narration" else "Enter fullscreen narration"
        fullscreenButton.invalidate()
        setPadding(if (value) 0 else dp(16), if (value) 0 else dp(4),
            if (value) 0 else dp(16), if (value) 0 else dp(8))
        updateReadingChrome()
    }

    private fun updateReadingChrome() {
        readingControls.visibility = if (hasNarration && !fullscreen) VISIBLE else GONE
        footer.visibility = if (fullscreen) GONE else VISIBLE
        val showButton = hasNarration || fullscreen
        fullscreenButton.visibility = if (showButton) VISIBLE else GONE
        val bottom = if (showButton) dp(48) else 0
        if (scroll.paddingBottom != bottom) scroll.setPadding(0, 0, 0, bottom)
    }

    fun floatingNarration(): String? = if (visibility == VISIBLE && hasNarration) displayed else null

    fun currentSection(): BooksSectionTranscript? {
        if (visibility != VISIBLE || destroyed || currentState.failed) return null
        val session = currentState.session ?: return null
        val section = BooksSectionResolver.at(session, currentState.positionMs) ?: return null
        return if (localMode) BooksSectionResolver.local(section, transcript) else windows.sectionTranscript(section)
    }

    private fun summarySelection(): BooksSummarySelection? {
        if (visibility != VISIBLE || destroyed || currentState.failed) return null
        val key = request ?: return null
        val session = currentState.session ?: return null
        val section = BooksSectionResolver.at(session, currentState.positionMs) ?: return null
        return BooksSummarySelection(key.itemId, session, section, windows.revision)
    }

    fun requestCurrentSummary(retryTranscript: Boolean = false, onState: (BooksSummaryState) -> Unit): Boolean {
        val selection = summarySelection() ?: return false
        val connection = books ?: return false
        cancelSummary()
        val ticket = summaryScope.begin(selection)
        summaryCallback = onState
        onState(BooksSummaryState.Preparing)
        if (!summaryScope.accepts(ticket, summarySelection())) return false
        fun deliver(state: BooksSummaryState) {
            main.post {
                if (!summaryScope.accepts(ticket, summarySelection(), state.revision)) return@post
                summaryCallback?.invoke(state)
            }
        }
        summaryFuture = summaryWorker.submit {
            try {
                val paired = transcriberStore.load() ?: throw BooksSummaryException(BooksSummaryFailure.UNAVAILABLE)
                val result = RemoteBooksSummary(paired, connection).load(selection, retryTranscript) { deliver(it) }
                deliver(result)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (error: BooksSummaryException) {
                deliver(BooksSummaryState.Failed(error.failure))
            } catch (_: Exception) {
                if (!Thread.currentThread().isInterrupted) deliver(BooksSummaryState.Failed(BooksSummaryFailure.NETWORK_OR_RESPONSE))
            }
        }
        return true
    }

    fun cancelSummary() {
        summaryScope.cancel()
        summaryFuture?.cancel(true)
        summaryFuture = null
        summaryWorker.purge()
        val callback = summaryCallback
        summaryCallback = null
        callback?.invoke(BooksSummaryState.Cancelled)
    }

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
        cancelSummary()
        generation++
        pending?.cancel(true)
        pending = null
        request = null
        books = null
        windows.clear()
        localMode = false
        transcript = null
        displayed = null
        currentState = BooksPlayerState()
        narration.text = ""
        details.text = ""
        hasNarration = false
        cover.visibility = VISIBLE
        scroll.visibility = GONE
        setFullscreen(false)
        updateReadingChrome()
        reload.visibility = GONE
        visibility = GONE
    }

    fun destroy() {
        close()
        destroyed = true
        worker.shutdownNow()
        summaryWorker.shutdownNow()
    }

    fun render(state: BooksPlayerState) {
        if (visibility != VISIBLE) return
        currentState = state
        if (summaryScope.active && !summaryScope.matches(summarySelection())) cancelSummary()
        val ready = state.session != null && !state.failed
        val session = state.session
        if (ready && !localMode) {
            windows.plan(state.positionMs, session.durationMs, state.wantsPlay)?.let(::load)
        }
        val window = session?.let { windows.current(state.positionMs, it.durationMs) }
        val document = if (localMode) transcript else window?.transcript
        val failed = session != null && windows.failed(state.positionMs, session.durationMs)
        val presentation = BooksNarrationPresentation.resolve(document != null, ready, localMode, failed)
        hasNarration = presentation == BooksNarrationPresentation.NARRATION
        cover.visibility = if (hasNarration) GONE else VISIBLE
        scroll.visibility = if (hasNarration) VISIBLE else GONE
        updateReadingChrome()
        details.text = when (presentation) {
            BooksNarrationPresentation.NARRATION -> ""
            BooksNarrationPresentation.LOADING -> "Preparing narration…"
            BooksNarrationPresentation.UNAVAILABLE -> "Narration unavailable · audio continues"
            BooksNarrationPresentation.COVER -> ""
        }
        reload.visibility = if (ready && presentation == BooksNarrationPresentation.UNAVAILABLE) VISIBLE else GONE
        reload.isEnabled = pending == null
        val text = if (hasNarration) document?.cueAt(state.positionMs)?.text ?: "…" else null
        if (text != displayed) {
            displayed = text
            narration.text = text.orEmpty()
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

    private class NarrationFullscreenButton(context: Context) : ImageButton(context) {
        var expanded = false
        private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            style = Paint.Style.STROKE
            strokeWidth = 2f * resources.displayMetrics.density
            strokeCap = Paint.Cap.SQUARE
        }

        init {
            setBackgroundColor(Color.TRANSPARENT)
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val radius = 10f * resources.displayMetrics.density
            val arm = 6f * resources.displayMetrics.density
            val cx = width / 2f
            val cy = height / 2f
            for (sx in listOf(-1f, 1f)) {
                for (sy in listOf(-1f, 1f)) {
                    val x = cx + sx * (if (expanded) radius - arm else radius)
                    val y = cy + sy * (if (expanded) radius - arm else radius)
                    val direction = if (expanded) 1f else -1f
                    canvas.drawLine(x, y, x + sx * arm * direction, y, stroke)
                    canvas.drawLine(x, y, x, y + sy * arm * direction, stroke)
                }
            }
        }
    }

    private companion object {
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
    }
}
