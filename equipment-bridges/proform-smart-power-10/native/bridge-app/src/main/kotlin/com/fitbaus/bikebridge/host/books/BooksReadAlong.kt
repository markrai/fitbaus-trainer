// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
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
    private val playbackPosition: (() -> Long)? = null,
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
    private val inlineAttempt = BooksInlineSummaryAttempt()
    private val sectionPlans = BooksSectionPlans()
    private var planningSelection: BooksSummarySelection? = null
    private var planGeneration = 0L
    private var summaryFuture: Future<*>? = null
    private var summaryCallback: ((BooksSummaryState) -> Unit)? = null
    private val narration = label("", 36f)
    private val inlineSummary = label("", BooksSummaryPresentation.INLINE_SIZE_SP)
    private val details = label("", 14f)
    private val scroll = ScrollView(context)
    private val narrationViewport = BooksNarrationViewport(context, scroll, narration, inlineSummary)
    private val reload = flatAction("Retry narration")
    val cover = ImageView(context)
    private val readingControls = LinearLayout(context)
    private val footer = LinearLayout(context)
    private val actions = LinearLayout(context)
    private val fullscreenButton = NarrationFullscreenButton(context)
    private var recapSelection: BooksRecapSelection? = null
    private val summaryPanel = LinearLayout(context)
    private val summaryTitle = label("Section summary", 26f)
    private val summaryRange = label("", 16f)
    private val summaryNotice = label("AI-generated · May reveal upcoming narration", 14f)
    private val summaryText = label("", 26f)
    private val summaryScroll = ScrollView(context)
    private val summaryRetry = flatAction("Retry summary")
    private var summarySection: BooksSection? = null
    private var summaryState: BooksSummaryState? = null
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
        readingControls.gravity = Gravity.RIGHT or Gravity.CENTER_VERTICAL
        readingControls.visibility = GONE
        fontSizeLabel.setTextColor(0xffa0a0a0.toInt())
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
                narrationViewport.requestLayout()
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
        narration.setTextColor(0xfff5f5f5.toInt())
        narration.gravity = Gravity.CENTER
        narration.setPadding(dp(12), dp(6), dp(12), dp(6))
        narration.setLineSpacing(dp(4).toFloat(), 1.12f)
        scroll.isFillViewport = true
        scroll.addView(narration, FrameLayout.LayoutParams(MATCH, WRAP))
        inlineSummary.apply {
            gravity = Gravity.CENTER_HORIZONTAL
            setTypeface(Typeface.DEFAULT, Typeface.ITALIC)
            setTextColor(0xffbfbfbf.toInt())
            setLineSpacing(dp(1).toFloat(), 1.08f)
        }
        cover.scaleType = ImageView.ScaleType.FIT_CENTER
        cover.contentDescription = "Audiobook cover"
        val stage = FrameLayout(context)
        stage.addView(cover, FrameLayout.LayoutParams(MATCH, MATCH))
        stage.addView(narrationViewport, FrameLayout.LayoutParams(MATCH, MATCH))
        buildSummaryPanel()
        stage.addView(summaryPanel, FrameLayout.LayoutParams(MATCH, MATCH))
        fullscreenButton.visibility = GONE
        fullscreenButton.contentDescription = "Enter fullscreen narration"
        fullscreenButton.setOnClickListener { onFullscreenRequested() }
        scroll.visibility = GONE
        addView(stage, LayoutParams(MATCH, 0, 1f))
        actions.orientation = HORIZONTAL
        actions.gravity = Gravity.CENTER_VERTICAL
        actions.addView(android.view.View(context), LayoutParams(0, 1, 1f))
        actions.addView(fullscreenButton, LayoutParams(dp(48), dp(44)))
        addView(actions, LayoutParams(MATCH, WRAP))
        footer.apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        details.setTextColor(0xffa0a0a0.toInt())
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
        if (!value) {
            inlineAttempt.reset()
            dismissSummary()
        }
        fullscreenButton.expanded = value
        fullscreenButton.contentDescription = if (value) "Exit fullscreen narration" else "Enter fullscreen narration"
        fullscreenButton.invalidate()
        setPadding(if (value) 0 else dp(16), if (value) 0 else dp(4),
            if (value) 0 else dp(16), if (value) 0 else dp(8))
        updateReadingChrome()
        if (value) maybeStartInlineSummary()
    }

    private fun updateReadingChrome() {
        readingControls.visibility = if (hasNarration && !fullscreen) VISIBLE else GONE
        footer.visibility = if (!fullscreen && (details.text.isNotEmpty() || reload.visibility == VISIBLE)) VISIBLE else GONE
        val showButton = hasNarration || fullscreen
        fullscreenButton.visibility = if (showButton) VISIBLE else GONE
        updateSummaryChrome()
    }

    private fun buildSummaryPanel() {
        summaryPanel.orientation = VERTICAL
        summaryPanel.setBackgroundColor(Color.BLACK)
        summaryPanel.setPadding(dp(24), dp(12), dp(24), dp(8))
        summaryPanel.visibility = GONE
        summaryTitle.setTextColor(0xFFFFCE1B.toInt())
        summaryTitle.gravity = Gravity.CENTER
        summaryPanel.addView(summaryTitle, LayoutParams(MATCH, WRAP))
        summaryRange.gravity = Gravity.CENTER
        summaryRange.setTextColor(Color.LTGRAY)
        summaryPanel.addView(summaryRange, LayoutParams(MATCH, WRAP))
        summaryNotice.gravity = Gravity.CENTER
        summaryNotice.setTextColor(Color.LTGRAY)
        summaryNotice.setPadding(0, dp(4), 0, dp(8))
        summaryPanel.addView(summaryNotice, LayoutParams(MATCH, WRAP))
        summaryScroll.isFillViewport = true
        summaryText.gravity = Gravity.CENTER_VERTICAL
        summaryText.setPadding(dp(8), dp(8), dp(8), dp(8))
        summaryText.setLineSpacing(dp(4).toFloat(), 1.12f)
        summaryScroll.addView(summaryText, FrameLayout.LayoutParams(MATCH, WRAP))
        summaryPanel.addView(summaryScroll, LayoutParams(MATCH, 0, 1f))
        summaryRetry.setAllCaps(false)
        summaryRetry.visibility = GONE
        summaryRetry.setOnClickListener {
            val recap = recapSelection
            when (val state = summaryState) {
                is BooksSummaryState.MissingCoverage -> {
                    if (recap != null && canShowRecap()) showRecap(false, recap.copy(cumulative = false))
                }
                is BooksSummaryState.Failed -> {
                    if (BooksSummaryPresentation.retryable(state.failure)) {
                        val retry = state.failure == BooksSummaryFailure.BOOK_CHANGED_OR_TRANSCRIPT_FAILED
                        if (recap != null) showRecap(retry, recap) else showSummary(retry)
                    }
                }
                else -> Unit
            }
        }
        val retryParams = LayoutParams(WRAP, dp(48))
        retryParams.gravity = Gravity.CENTER_HORIZONTAL
        summaryPanel.addView(summaryRetry, retryParams)
    }

    private fun canShowSummary(): Boolean = fullscreen && !localMode && windows.summaryAvailable &&
        summarySelection() != null

    private fun livePosition(): Long = playbackPosition?.invoke() ?: currentState.positionMs

    private fun recapContextAvailable(): Boolean = fullscreen && visibility == VISIBLE && !destroyed &&
        !currentState.failed && currentState.session != null && request != null &&
        !localMode && windows.revision != null

    private fun canShowRecap(): Boolean = recapContextAvailable() && windows.recapAvailable

    private fun canShowBookRecap(positionMs: Long = currentState.positionMs): Boolean =
        recapContextAvailable() && windows.cumulativeRecapMaxPositionMs?.let { positionMs in 0..it } == true

    private fun recapMatches(selection: BooksRecapSelection): Boolean =
        (if (selection.cumulative) canShowBookRecap(selection.positionMs) else canShowRecap()) &&
            selection.matches(request?.itemId, currentState.session, windows.revision,
                currentState.seekGeneration, livePosition())

    private fun updateSummaryChrome() {
        val showing = BooksPlayerPresentation.recapPanelVisible(fullscreen, recapSelection != null)
        summaryPanel.visibility = if (showing) VISIBLE else GONE
        actions.visibility = if (fullscreenButton.visibility == VISIBLE) VISIBLE else GONE
        if (summaryState is BooksSummaryState.MissingCoverage) {
            summaryRetry.visibility = if (canShowRecap()) VISIBLE else GONE
        }
        cover.visibility = if (!showing && !hasNarration) VISIBLE else GONE
        scroll.visibility = if (!showing && hasNarration) VISIBLE else GONE
        val text = BooksSummaryPresentation.inlineText(summaryState,
            fullscreen && hasNarration && !showing && summarySection != null && canShowSummary())
        narrationViewport.setSummary(text)
    }

    private fun maybeStartInlineSummary() {
        if (!fullscreen || !hasNarration || recapSelection != null || summarySection != null || !canShowSummary()) return
        val selection = summarySelection() ?: return
        if (!inlineAttempt.begin(selection)) return
        showSummary(false)
    }

    private fun showSummary(retryTranscript: Boolean) {
        if (!canShowSummary()) return
        val selection = summarySelection() ?: return
        val connection = books ?: return
        dismissSummary()
        summarySection = selection.section
        presentSummary(BooksSummaryState.Preparing)
        val block = sectionPlans.pendingBlock(selection.session, currentState.positionMs)
        val revision = selection.expectedRevision
        if (block == null || revision == null) {
            startSelectedSummary(retryTranscript)
            return
        }
        if (!windows.sectionPlanAvailable) {
            sectionPlans.freeze(selection.session, block, block.boundaries)
            startSelectedSummary(retryTranscript)
            return
        }
        planningSelection = selection
        val ticket = ++planGeneration
        summaryFuture = summaryWorker.submit {
            val cuts = try {
                val paired = transcriberStore.load() ?: throw BooksSummaryException(BooksSummaryFailure.UNAVAILABLE)
                RemoteBooksSectionPlan(paired, connection).load(selection.itemId, revision, block)
            } catch (_: Exception) {
                if (Thread.currentThread().isInterrupted) return@submit
                block.boundaries
            }
            main.post {
                if (ticket != planGeneration || planningSelection == null) return@post
                if (!canShowSummary() || !planningMatches()) {
                    dismissSummary()
                    return@post
                }
                planningSelection = null
                summaryFuture = null
                sectionPlans.freeze(selection.session, block, cuts)
                startSelectedSummary(retryTranscript)
            }
        }
    }

    private fun showRecap(retryTranscript: Boolean, previous: BooksRecapSelection? = null,
                          cumulative: Boolean = previous?.cumulative ?: false) {
        val session = currentState.session ?: return
        val key = request ?: return
        val revision = windows.revision ?: return
        val connection = books ?: return
        val position = previous?.positionMs ?: livePosition().coerceIn(0, session.durationMs)
        if (!(if (cumulative) canShowBookRecap(position) else canShowRecap())) return
        val selection = previous ?: BooksRecapSelection(key.itemId, session, position, revision,
            currentState.seekGeneration, cumulative)
        if (!recapMatches(selection)) {
            dismissSummary()
            return
        }
        dismissSummary()
        recapSelection = selection
        summaryTitle.text = if (selection.cumulative) "Book recap" else "Recent recap"
        summaryNotice.text = "AI-generated · Narration before the requested position"
        summaryRetry.text = "Retry recap"
        summaryRange.text = BooksSummaryPresentation.recapRange(selection)
        presentSummary(BooksSummaryState.Preparing)
        val ticket = ++planGeneration
        fun deliver(state: BooksSummaryState) {
            main.post {
                if (ticket != planGeneration || recapSelection !== selection) return@post
                if (!recapMatches(selection) || (state.revision != null && state.revision != selection.expectedRevision)) {
                    dismissSummary()
                    return@post
                }
                presentSummary(state)
            }
        }
        summaryFuture = summaryWorker.submit {
            try {
                val paired = transcriberStore.load() ?: throw BooksSummaryException(BooksSummaryFailure.UNAVAILABLE)
                val remote = RemoteBooksSummary(paired, connection)
                val result = if (selection.cumulative) remote.loadBookRecap(selection) { deliver(it) }
                    else remote.loadRecap(selection, retryTranscript) { deliver(it) }
                deliver(result)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (error: BooksSummaryException) {
                deliver(BooksSummaryState.Failed(error.failure))
            } catch (_: Exception) {
                if (!Thread.currentThread().isInterrupted) deliver(BooksSummaryState.Failed(BooksSummaryFailure.NETWORK_OR_RESPONSE))
            }
        }
    }

    private fun planningMatches(): Boolean {
        val original = planningSelection ?: return false
        val current = summarySelection() ?: return false
        return current.session === original.session && current.itemId == original.itemId &&
            current.expectedRevision == original.expectedRevision && current.section == original.section
    }

    private fun startSelectedSummary(retryTranscript: Boolean) {
        val selection = summarySelection()
        if (selection == null) {
            dismissSummary()
            return
        }
        inlineAttempt.mark(selection)
        summarySection = selection.section
        if (!requestCurrentSummary(retryTranscript, ::presentSummary)) dismissSummary()
    }

    private fun presentSummary(state: BooksSummaryState) {
        if (state == BooksSummaryState.Cancelled) {
            clearSummaryPanel()
            return
        }
        if (!fullscreen || (summarySection == null && recapSelection == null)) return
        summaryState = state
        if (recapSelection == null) {
            updateSummaryChrome()
            return
        }
        val presentation = BooksSummaryPresentation.resolve(state, recap = recapSelection != null,
            cumulative = recapSelection?.cumulative == true)
        summaryText.text = presentation.text
        if (recapSelection != null) {
            summaryRetry.text = if (state is BooksSummaryState.MissingCoverage) "Recent recap" else "Retry recap"
        }
        summaryRetry.visibility = if (presentation.retry ||
            (state is BooksSummaryState.MissingCoverage && canShowRecap())) VISIBLE else GONE
        summaryScroll.scrollTo(0, 0)
        updateSummaryChrome()
    }

    private fun clearSummaryPanel() {
        summarySection = null
        recapSelection = null
        summaryState = null
        summaryText.text = ""
        summaryRange.text = ""
        summaryRetry.visibility = GONE
        summaryScroll.scrollTo(0, 0)
        updateSummaryChrome()
    }

    fun dismissSummary() {
        clearSummaryPanel()
        cancelSummary()
    }

    fun floatingNarration(): String? = if (visibility == VISIBLE && hasNarration) displayed else null

    fun currentSection(): BooksSectionTranscript? {
        if (visibility != VISIBLE || destroyed || currentState.failed) return null
        val session = currentState.session ?: return null
        val section = sectionPlans.at(session, currentState.positionMs) ?: return null
        return if (localMode) BooksSectionResolver.local(section, transcript) else windows.sectionTranscript(section)
    }

    private fun summarySelection(): BooksSummarySelection? {
        if (visibility != VISIBLE || destroyed || currentState.failed) return null
        val key = request ?: return null
        val session = currentState.session ?: return null
        val section = sectionPlans.at(session, currentState.positionMs) ?: return null
        return BooksSummarySelection(key.itemId, session, section, windows.revision)
    }

    fun requestCurrentSummary(retryTranscript: Boolean = false, onState: (BooksSummaryState) -> Unit): Boolean {
        if (!canShowSummary()) return false
        val selection = summarySelection() ?: return false
        val connection = books ?: return false
        cancelSummary()
        val ticket = summaryScope.begin(selection)
        summaryCallback = onState
        onState(BooksSummaryState.Preparing)
        if (!summaryScope.accepts(ticket, summarySelection())) return false
        fun deliver(state: BooksSummaryState) {
            main.post {
                val current = summarySelection()
                if (!summaryScope.accepts(ticket, current)) return@post
                if (!summaryScope.accepts(ticket, current, state.revision)) {
                    cancelSummary()
                    return@post
                }
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
        planGeneration++
        planningSelection = null
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
        inlineAttempt.reset()
        dismissSummary()
        generation++
        pending?.cancel(true)
        pending = null
        request = null
        books = null
        windows.clear()
        sectionPlans.clear()
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
        val ready = state.session != null && !state.failed
        val session = state.session
        if (ready && windows.revision != null && !localMode) {
            sectionPlans.configure(session, windows.sectionPlanAvailable)
        }
        if ((summaryScope.active && (!summaryScope.matches(summarySelection()) || !canShowSummary())) ||
            (planningSelection != null && (!planningMatches() || !canShowSummary())) ||
            recapSelection?.let { !recapMatches(it) } == true) dismissSummary()
        if (ready && !localMode) {
            windows.plan(state.positionMs, session.durationMs, state.wantsPlay)?.let(::load)
        }
        val window = session?.let { windows.current(state.positionMs, it.durationMs) }
        val document = if (localMode) transcript else window?.transcript
        val failed = session != null && windows.failed(state.positionMs, session.durationMs)
        val presentation = BooksNarrationPresentation.resolve(document != null, ready, localMode, failed)
        hasNarration = presentation == BooksNarrationPresentation.NARRATION
        details.text = when (presentation) {
            BooksNarrationPresentation.NARRATION -> ""
            BooksNarrationPresentation.LOADING -> "Preparing narration…"
            BooksNarrationPresentation.UNAVAILABLE -> "Narration unavailable · audio continues"
            BooksNarrationPresentation.COVER -> ""
        }
        reload.visibility = if (ready && presentation == BooksNarrationPresentation.UNAVAILABLE) VISIBLE else GONE
        reload.isEnabled = pending == null
        updateReadingChrome()
        val text = if (hasNarration) document?.cueAt(state.positionMs)?.text ?: "…" else null
        if (text != displayed) {
            displayed = text
            narration.text = text.orEmpty()
            scroll.scrollTo(0, 0)
            narrationViewport.requestLayout()
        }
        maybeStartInlineSummary()
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

    private fun flatAction(value: String) = Button(context).apply {
        text = value
        setAllCaps(false)
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.TRANSPARENT)
        stateListAnimator = null
        elevation = 0f
    }

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
