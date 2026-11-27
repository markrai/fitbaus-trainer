package com.fitbaus.bikebridge.host.books

import android.app.AlertDialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import com.fitbaus.bikebridge.host.ui.NativeDialogStyle
import com.fitbaus.bikebridge.host.ui.NativeDialogViews
import com.fitbaus.bikebridge.host.ui.setDialogTreeEnabled
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal class TranscriberManagementDialog(
    private val context: Context,
    private val connection: TranscriberConnection?,
    private val books: BooksConnection? = null,
    private val item: BooksItem? = null,
    private val playback: BooksPlaybackSession? = null,
    private val onGrant: (TranscriberManagement, String) -> Unit = { _, _ -> },
) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val views = NativeDialogViews(context, NativeDialogStyle.TRANSCRIPTION_MODELS)
    private val rows = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(10), dp(16), dp(16))
    }
    private val status = TextView(context).apply {
        textSize = 15f
        setTextColor(MUTED)
        setPadding(dp(20), dp(8), dp(20), dp(8))
    }
    private val scroll by lazy { ScrollView(context).apply { addView(rows) } }
    private var embedded = false
    private var onReadiness: (TranscriberReadiness) -> Unit = {}
    private val refresh = Button(context).apply {
        text = if (item != null) "Refresh transcription" else "Refresh models"
        isAllCaps = false
        textSize = 15f
        backgroundTintList = null
        setTextColor(Color.WHITE)
        background = surface(NativeDialogStyle.TRANSCRIPTION_MODELS.buttonFill, NativeDialogStyle.TRANSCRIPTION_MODELS.buttonBorder)
    }
    private val dialog by lazy { AlertDialog.Builder(context)
        .setTitle(if (item != null) "Transcription" else "Transcription Models")
        .setView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xff101720.toInt())
            addView(status)
            addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
            addView(refresh, LinearLayout.LayoutParams(-1, dp(48)).apply {
                setMargins(dp(16), dp(4), dp(16), dp(8))
            })
        })
        .setNegativeButton("CLOSE", null)
        .create() }
    private var login: AlertDialog? = null
    private var pending: Future<*>? = null
    private var closed = false
    private var last: PreparationSnapshot? = null
    private var selectedModel = "tiny"
    private var client: TranscriberManagement? = null
    private val poll = Runnable { if (login == null) load() }

    fun show(): AlertDialog {
        dialog.setOnDismissListener { close() }
        refresh.setOnClickListener { load() }
        dialog.show()
        dialog.window?.setLayout(-1, -1)
        load()
        return dialog
    }

    fun attach(parent: LinearLayout, onReadiness: (TranscriberReadiness) -> Unit = {}) {
        check(!closed && !embedded)
        embedded = true
        this.onReadiness = onReadiness
        rows.setPadding(0, dp(4), 0, dp(8))
        status.setPadding(dp(4), dp(8), dp(4), dp(8))
        parent.addView(status)
        parent.addView(rows, LinearLayout.LayoutParams(-1, -2))
        parent.addView(refresh, LinearLayout.LayoutParams(-1, dp(48)))
        refresh.setOnClickListener { load() }
        load()
    }

    fun close() {
        if (closed) return
        closed = true
        onReadiness = {}
        main.removeCallbacks(poll)
        login?.dismiss()
        login = null
        pending?.cancel(true)
        pending = null
        worker.shutdownNow()
    }

    private fun load() = request {
        val api = client ?: TranscriberManagement(
            connection ?: TranscriberConnectionStore(context).load()
                ?: throw IllegalStateException("Pair Transcriber in Settings first"),
            books, item, playback,
        ).also { client = it }
        api.snapshot()
    }

    private fun request(action: () -> PreparationSnapshot) {
        if (closed || pending != null || login != null) return
        main.removeCallbacks(poll)
        refresh.isEnabled = false
        enableRows(false)
        if (last == null) status.text = if (item != null) "Loading book transcription…" else "Loading models…"
        pending = worker.submit {
            val result = runCatching(action)
            main.post {
                if (closed) return@post
                pending = null
                refresh.isEnabled = true
                result.fold({ snapshot ->
                    last = snapshot
                    onReadiness(snapshot.readiness)
                    render(snapshot)
                    if (shouldPoll()) {
                        main.postDelayed(poll, 5000)
                    }
                }, { error ->
                    status.text = when (error) {
                        is BooksHttpFailure -> when (error.status) {
                            401, 403 -> "Authorization rejected. Check your pairing or Audiobookshelf sign-in."
                            409 -> "Action unavailable. Refresh to check the model and job state."
                            503 -> "Server busy or not ready. Refresh to retry."
                            else -> "Request failed (HTTP ${error.status})."
                        }
                        else -> "Unable to load or manage transcription. Check server settings and version."
                    }
                    onReadiness(TranscriberReadiness.CheckIncomplete)
                    last?.let { renderRows(it, false) }
                })
            }
        }
    }

    private fun enableRows(enabled: Boolean) = setDialogTreeEnabled(rows, enabled)

    private fun mutate(action: (TranscriberManagement) -> Unit) {
        request {
            val api = requireNotNull(client)
            action(api)
            api.snapshot()
        }
    }

    private fun render(snapshot: PreparationSnapshot) {
        status.text = when {
            item != null && !snapshot.sourceMatches -> "Audiobookshelf address differs from the Transcriber's configured source. Check Settings."
            item != null && !snapshot.canPrepare -> "Update the Transcriber server to manage preparation."
            item != null -> "Choose an installed, qualified model to prepare narration for this audiobook."
            !snapshot.canManageModels -> "Update the Transcriber server to manage model downloads from the bike."
            else -> "Speech-to-text models run on your Transcriber server. Tiny is bundled; Base and Small are optional."
        }
        renderRows(snapshot, true)
    }

    private fun renderRows(snapshot: PreparationSnapshot, enabled: Boolean) {
        val position = if (embedded) 0 else scroll.scrollY
        rows.removeAllViews()
        if (!enabled) label("Last reported state · refresh to update", 14f)
        val visibleModels = if (item != null) bookPreparationModels(snapshot.models) else snapshot.models
        val bookSelection = if (item != null) bookPreparationSelection(visibleModels, selectedModel) else null
        if (bookSelection != null) selectedModel = bookSelection
        if (item != null) {
            heading(item.title)
            label("Choose a model", 16f, rows, Color.WHITE, true)
            if (visibleModels.isEmpty()) label("No installed, qualified models. Manage models in Settings → Transcriber → Transcription models.", 16f)
        } else if (visibleModels.isEmpty()) {
            label("No transcription models reported. Refresh or check the server version.", 16f)
        }
        val columns = modelCardsUseColumns(context.resources.configuration.screenWidthDp)
        val models = LinearLayout(context).apply {
            orientation = if (columns) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        }
        rows.addView(models, LinearLayout.LayoutParams(-1, -2))
        for (model in visibleModels) {
            val presentation = modelCardPresentation(model)
            val selected = item != null && bookSelection == model.id
            val card = panel(selected || (item == null && model.id == "tiny")).apply {
                gravity = Gravity.TOP
                minimumHeight = dp(if (columns && item == null) 232 else 0)
            }
            models.addView(card, LinearLayout.LayoutParams(if (columns) 0 else -1,
                if (columns) -1 else -2, if (columns) 1f else 0f).apply {
                setMargins(dp(4), dp(4), dp(4), dp(8))
            })
            label(presentation.title, 26f, card, Color.WHITE, true)
            label(presentation.role, 13f, card, ACCENT, true)
            label(presentation.description, 15f, card)
            card.addView(View(context).apply { setBackgroundColor(0xff455368.toInt()) },
                LinearLayout.LayoutParams(-1, dp(1)).apply { topMargin = dp(8); bottomMargin = dp(4) })
            val statusColor = when (presentation.tone) {
                ModelCardTone.Ready -> SUCCESS
                ModelCardTone.Working -> ACCENT
                ModelCardTone.Attention -> 0xffffb47a.toInt()
                ModelCardTone.Neutral -> MUTED
            }
            val statusText = if (presentation.tone == ModelCardTone.Ready) "✓ ${presentation.status}" else presentation.status
            label(statusText, 16f, card, if (enabled) statusColor else MUTED, true)
            presentation.detail?.let { label(it, 14f, card) }
            presentation.progressValue?.let { progress(it, presentation.progressMax, card) }
            if (columns) card.addView(View(context), LinearLayout.LayoutParams(1, 0, 1f))
            if (item != null) {
                button(if (selected) "SELECTED" else "SELECT", enabled && snapshot.canPrepare && !selected, card, selected) {
                    selectedModel = model.id
                    renderRows(snapshot, true)
                }
            } else {
                renderModelManagementActions(model, snapshot, enabled, card)
            }
        }
        if (item != null) {
            if (bookSelection != null) {
                val existing = snapshot.jobs.any { it.model == bookSelection && it.currentRevision }
                val actionPanel = panel(false)
                rows.addView(actionPanel, LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(4), dp(4), dp(4), dp(10)) })
                label("Generate narration in advance. Audio playback continues while the server works.", 15f, actionPanel)
                button("START ${bookSelection.uppercase(Locale.US)} TRANSCRIPTION",
                    enabled && snapshot.canPrepare && !existing, actionPanel, true) {
                    mutate { api -> api.start(bookSelection)?.let { onGrant(api, it) } }
                }
                if (existing) label("A transcription for this model already exists below.", 14f, actionPanel)
            }
            heading("Transcription jobs")
            if (snapshot.jobs.isEmpty()) label("No transcription jobs yet.", 15f)
            for (job in snapshot.jobs) {
                val jobCard = panel(false)
                rows.addView(jobCard, LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(4), dp(4), dp(4), dp(8)) })
                val header = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
                val modelLabel = TextView(context).apply {
                    text = job.model.uppercase(Locale.US)
                    textSize = 19f
                    setTextColor(Color.WHITE)
                    typeface = Typeface.DEFAULT_BOLD
                }
                header.addView(modelLabel, LinearLayout.LayoutParams(0, -2, 1f))
                label(job.state.replace('_', ' ').uppercase(Locale.US) +
                    if (job.currentRevision) "" else " · AUDIO CHANGED", 14f, header, ACCENT, true, false)
                jobCard.addView(header)
                progress(job.processed, job.total, jobCard)
                label("${duration(job.processed)} / ${duration(job.total)} · ${job.processed * 100 / job.total}%", 16f, jobCard)
                job.error?.let { label(it.replace('_', ' '), 14f, jobCard) }
                val actions = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
                jobCard.addView(actions)
                if (job.running) button("PAUSE", enabled, actions) { mutate { it.action(job, "pause") } }
                if (job.canResume) button("RESUME", enabled, actions, true) { mutate { api -> api.action(job, "resume")?.let { onGrant(api, it) } } }
                if (job.running || job.canResume) button("CANCEL", enabled, actions) {
                    confirm("Cancel this job? Completed windows remain available.") { mutate { it.action(job, "cancel") } }
                }
                if (job.canDiscard) button("DISCARD", enabled, actions) {
                    confirm("Delete this job and all its prepared transcripts?") { mutate { it.action(job, "discard") } }
                }
            }
        }
        if (!embedded) scroll.post { if (!closed) scroll.scrollTo(0, position) }
    }

    private fun renderModelManagementActions(
        model: PreparationModel,
        snapshot: PreparationSnapshot,
        enabled: Boolean,
        card: LinearLayout,
    ) {
        if (model.downloading) {
            button("CANCEL DOWNLOAD", enabled && snapshot.canManageModels, card) { mutate { it.download(model.id, true) } }
        } else if (!model.installed && model.id != "tiny") {
            button(if (model.state in setOf("failed", "interrupted")) "RETRY DOWNLOAD" else "DOWNLOAD",
                enabled && snapshot.canManageModels && snapshot.models.none { it.downloading }, card, true) {
                mutate { it.download(model.id) }
            }
        } else if (model.installed && !model.qualified && !model.qualifying && snapshot.automaticQualification) {
            button("RETRY CHECK", enabled && snapshot.canManageModels, card) { mutate { it.retryQualification(model.id) } }
        }
    }

    private fun shouldPoll(): Boolean = last?.let { snapshot ->
        snapshot.models.any { it.downloading || it.qualifying } || snapshot.jobs.any { it.running }
    } == true

    private fun confirm(message: String, action: () -> Unit) {
        main.removeCallbacks(poll)
        val prompt = AlertDialog.Builder(context).setMessage(message).setNegativeButton("KEEP", null)
            .setPositiveButton("CONFIRM", null).create()
        login = prompt
        prompt.setOnDismissListener {
            login = null
            if (!closed && pending == null && shouldPoll()) main.postDelayed(poll, 5000)
        }
        prompt.show()
        prompt.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            prompt.dismiss()
            action()
        }
    }

    private fun surface(fill: Int, stroke: Int) = views.surface(fill, stroke)

    private fun panel(selected: Boolean) = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(12), dp(12), dp(12), dp(12))
        background = views.surface(if (selected) 0xff342f1c.toInt() else 0xff1a2330.toInt(),
            if (selected) ACCENT else NativeDialogStyle.TRANSCRIPTION_MODELS.buttonBorder, if (selected) 2 else 1)
    }

    private fun heading(value: String) = label(value, 21f, rows, Color.WHITE, true)

    private fun label(value: String, size: Float, parent: LinearLayout = rows, color: Int = MUTED,
                      bold: Boolean = false, fullWidth: Boolean = true) {
        views.label(parent, value, size, color, bold, fullWidth)
    }

    private fun button(value: String, enabled: Boolean, parent: LinearLayout = rows,
                       primary: Boolean = false, action: () -> Unit) {
        views.button(parent, value, enabled, primary, retainOpacity = value == "SELECTED") {
            if (!closed && pending == null) action()
        }
    }

    private fun progress(value: Long, max: Long, parent: LinearLayout = rows) {
        parent.addView(ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = max <= 0
            this.max = 1000
            progressTintList = ColorStateList.valueOf(ACCENT)
            progressBackgroundTintList = ColorStateList.valueOf(0xff384659.toInt())
            progress = if (max > 0) (value.toDouble() / max * 1000).toInt().coerceIn(0, 1000) else 0
        }, LinearLayout.LayoutParams(-1, dp(14)))
    }

    private companion object {
        val ACCENT = NativeDialogStyle.TRANSCRIPTION_MODELS.accent
        val MUTED = 0xffc1cbd7.toInt()
        val SUCCESS = 0xff58d5a5.toInt()
    }

    private fun duration(ms: Long) = String.format(Locale.US, "%d:%02d:%02d", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60)
    private fun dp(value: Int) = views.dp(value)
}
