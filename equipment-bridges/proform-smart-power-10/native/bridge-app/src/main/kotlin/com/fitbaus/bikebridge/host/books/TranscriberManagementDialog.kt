package com.fitbaus.bikebridge.host.books

import android.app.AlertDialog
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal class TranscriberManagementDialog(
    private val context: Context,
    private val connection: TranscriberConnection?,
    private val books: BooksConnection? = null,
    private val item: BooksItem? = null,
    private val playback: BooksPlaybackSession? = null,
) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val rows = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(8), dp(16), dp(12))
    }
    private val status = TextView(context).apply { textSize = 16f }
    private val scroll = ScrollView(context).apply { addView(rows) }
    private val refresh = Button(context).apply { text = "REFRESH" }
    private val dialog = AlertDialog.Builder(context)
        .setTitle(if (item == null) "Transcriber models" else "Prepare · " + item.title)
        .setView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(status)
            addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
            addView(refresh, LinearLayout.LayoutParams(-1, dp(48)))
        })
        .setNegativeButton("CLOSE", null)
        .create()
    private var login: AlertDialog? = null
    private var pending: Future<*>? = null
    private var closed = false
    private var last: PreparationSnapshot? = null
    private var selectedModel = "tiny"
    private var client: TranscriberManagement? = null
    private val poll = Runnable { if (login == null) load() }

    fun show(): AlertDialog {
        dialog.setOnDismissListener {
            closed = true
            main.removeCallbacks(poll)
            login?.dismiss()
            login = null
            pending?.cancel(true)
            worker.shutdownNow()
        }
        refresh.setOnClickListener { load() }
        dialog.show()
        dialog.window?.setLayout(-1, -1)
        load()
        return dialog
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
        status.text = "Loading…"
        pending = worker.submit {
            val result = runCatching(action)
            main.post {
                if (closed) return@post
                pending = null
                refresh.isEnabled = true
                result.fold({ snapshot ->
                    last = snapshot
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
                    last?.let { renderRows(it, false) }
                })
            }
        }
    }

    private fun enableRows(enabled: Boolean) {
        for (i in 0 until rows.childCount) rows.getChildAt(i).isEnabled = enabled
    }

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
            !snapshot.canManageModels -> "Update the Transcriber server to manage model downloads from the bike."
            else -> "Tiny is the live fallback. Prepared Small and Base windows take priority."
        }
        renderRows(snapshot, true)
    }

    private fun renderRows(snapshot: PreparationSnapshot, enabled: Boolean) {
        val position = scroll.scrollY
        rows.removeAllViews()
        label("Models", 20f)
        for (model in snapshot.models) {
            val title = model.id.replaceFirstChar { it.uppercase(Locale.US) }
            val description = when {
                model.downloading -> "${model.state} · ${megabytes(model.received)} / ${megabytes(model.total)}"
                !model.installed -> "Not installed · ${megabytes(model.total)}"
                !model.qualified && model.automaticState == "queued" -> "Installed · waiting to test hardware"
                !model.qualified && model.automaticState == "running" -> "Testing hardware · ${model.completedRuns} / ${model.totalRuns} checks complete"
                !model.qualified && model.automaticState == "waiting_resources" -> "Installed · waiting for available memory"
                !model.qualified && model.automaticState == "failed" -> "Hardware check did not pass"
                !model.qualified && snapshot.automaticQualification -> "Installed · waiting for hardware check"
                !model.qualified -> "Installed · server qualification required"
                !model.memoryAllowed -> "Installed · waiting for available memory"
                model.id == "tiny" -> "Installed · default"
                else -> "Installed · qualified"
            }
            label("$title · $description", 17f)
            if (model.downloading) {
                progress(model.received, model.total)
                button("CANCEL $title DOWNLOAD", enabled && snapshot.canManageModels) { mutate { it.download(model.id, true) } }
            } else if (!model.installed && model.id != "tiny") {
                button("DOWNLOAD $title", enabled && snapshot.canManageModels && snapshot.models.none { it.downloading }) {
                    selectedModel = model.id
                    mutate { it.download(model.id) }
                }
            } else if (model.installed && !model.qualified && model.qualifying) {
                if (model.automaticState == "running") progress(model.completedRuns.toLong(), model.totalRuns.toLong())
                label("Live Read Along takes priority. No audiobook audio is used for this check.", 14f)
            } else if (model.installed && !model.qualified && snapshot.automaticQualification) {
                model.qualificationError?.let { label(it.replace('_', ' '), 14f) }
                button("RETRY $title HARDWARE CHECK", enabled && snapshot.canManageModels) {
                    mutate { it.retryQualification(model.id) }
                }
            } else if (item != null && model.installed && model.qualified) {
                button(if (selectedModel == model.id) "$title SELECTED" else "SELECT $title",
                    enabled && snapshot.canPrepare) {
                    selectedModel = model.id
                    renderRows(snapshot, true)
                }
            }
        }
        if (item != null) {
            label("Prepare this audiobook", 20f)
            val model = snapshot.models.firstOrNull { it.id == selectedModel }
            val existing = snapshot.jobs.any { it.model == selectedModel && it.currentRevision }
            button("PREPARE " + selectedModel.uppercase(Locale.US),
                enabled && snapshot.canPrepare && model?.installed == true && model.qualified && !existing) {
                authorize { api, credentials -> api.start(selectedModel, credentials) }
            }
            if (existing) label("A job for this model already exists below. Resume it instead of starting over.", 14f)
            if (snapshot.jobs.isEmpty()) label("No prepared jobs yet.", 16f)
            for (job in snapshot.jobs) {
                label(job.model.uppercase(Locale.US) + " · " + job.state.replace('_', ' ') +
                    if (job.currentRevision) "" else " · audio changed", 18f)
                progress(job.processed, job.total)
                label("${duration(job.processed)} / ${duration(job.total)} · ${job.processed * 100 / job.total}%", 16f)
                job.error?.let { label(it.replace('_', ' '), 14f) }
                if (job.running) button("PAUSE", enabled) { mutate { it.action(job, "pause") } }
                if (job.canResume) button("RESUME", enabled) { authorize { api, credentials -> api.action(job, "resume", credentials) } }
                if (job.running || job.canResume) button("CANCEL JOB", enabled) {
                    confirm("Cancel this job? Completed windows remain available.") { mutate { it.action(job, "cancel") } }
                }
                if (job.canDiscard) button("DISCARD TRANSCRIPTS", enabled) {
                    confirm("Delete this job and all its prepared transcripts?") { mutate { it.action(job, "discard") } }
                }
            }
        }
        scroll.post { if (!closed) scroll.scrollTo(0, position) }
    }

    private fun authorize(action: (TranscriberManagement, BooksCredentials?) -> Unit) {
        val current = books ?: return
        if (current.session.credentials().refreshToken == null || last?.renewable != true) {
            mutate { action(it, null) }
            return
        }
        main.removeCallbacks(poll)
        val form = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), dp(8))
        }
        form.addView(TextView(context).apply {
            text = "Sign in once to authorize an independent background session. Your playback session remains separate. The password is not saved."
        })
        val username = EditText(context).apply {
            hint = "Audiobookshelf username"
            setSingleLine(true)
            filters = arrayOf(InputFilter.LengthFilter(256))
            isSaveEnabled = false
        }
        val password = EditText(context).apply {
            hint = "Password"
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            filters = arrayOf(InputFilter.LengthFilter(4096))
            isSaveEnabled = false
        }
        form.addView(username)
        form.addView(password)
        val prompt = AlertDialog.Builder(context).setTitle("Authorize preparation")
            .setView(form).setNegativeButton("CANCEL", null).setPositiveButton("SIGN IN", null).create()
        login = prompt
        prompt.setOnDismissListener {
            password.text.clear()
            username.text.clear()
            login = null
            if (!closed && pending == null && shouldPoll()) main.postDelayed(poll, 5000)
        }
        prompt.show()
        prompt.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val user = username.text.toString().trim()
            if (user.isBlank()) {
                username.error = "Enter your username"
                return@setOnClickListener
            }
            val secret = password.text.toString()
            password.text.clear()
            prompt.dismiss()
            mutate { api ->
                val credential = BooksAuth(current.server).login(user, secret)
                if (Thread.currentThread().isInterrupted) throw java.io.InterruptedIOException("Request cancelled")
                action(api, credential)
            }
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

    private fun label(value: String, size: Float) {
        rows.addView(TextView(context).apply {
            text = value
            textSize = size
            setPadding(0, dp(6), 0, dp(3))
        }, LinearLayout.LayoutParams(-1, -2))
    }

    private fun button(value: String, enabled: Boolean, action: () -> Unit) {
        rows.addView(Button(context).apply {
            text = value
            isEnabled = enabled
            setOnClickListener { if (!closed && pending == null) action() }
        }, LinearLayout.LayoutParams(-1, dp(48)))
    }

    private fun progress(value: Long, max: Long) {
        rows.addView(ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = max <= 0
            this.max = 1000
            progress = if (max > 0) (value.toDouble() / max * 1000).toInt().coerceIn(0, 1000) else 0
        }, LinearLayout.LayoutParams(-1, dp(16)))
    }

    private fun megabytes(bytes: Long) = String.format(Locale.US, "%.0f MB", bytes / 1_000_000.0)
    private fun duration(ms: Long) = String.format(Locale.US, "%d:%02d:%02d", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60)
    private fun dp(value: Int) = (value * context.resources.displayMetrics.density + 0.5f).toInt()
}
