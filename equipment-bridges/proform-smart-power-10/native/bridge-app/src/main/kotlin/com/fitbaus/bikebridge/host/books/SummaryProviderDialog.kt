package com.fitbaus.bikebridge.host.books

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.AdapterView
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal class SummaryProviderDialog(
    private val context: Context,
    private val connection: TranscriberConnection,
) {
    private val api = SummaryProviderManagement(connection)
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val rows = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(24), dp(12), dp(24), dp(20))
    }
    private val status = TextView(context).apply {
        textSize = 16f
        setTextColor(Color.WHITE)
        setPadding(dp(24), dp(12), dp(24), dp(8))
    }
    private val scroll = ScrollView(context).apply { addView(rows) }
    private val dialog = AlertDialog.Builder(context)
        .setTitle("Summarization provider")
        .setView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xff101720.toInt())
            addView(status)
            addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        })
        .setNegativeButton("CLOSE", null)
        .create()
    private var pending: Future<*>? = null
    private var closed = false
    private var current: SummaryProviderStatus? = null
    private var tested: String? = null
    private var secretFields = mutableListOf<EditText>()

    fun show(): AlertDialog {
        dialog.setOnDismissListener {
            closed = true
            clearSecrets()
            api.forgetGrant()
            pending?.cancel(true)
            worker.shutdownNow()
        }
        dialog.show()
        dialog.window?.setLayout(-1, -1)
        load()
        return dialog
    }

    private fun load() {
        resetRows()
        button("RETRY") { load() }
        request("Checking server…", { api.capabilities() }) { (supported, model) ->
            status.text = if (model != null) "Active model: $model" else "Summarization disabled or unavailable"
            if (!supported) {
                resetRows()
                label("Update FitBaus Transcriber to manage providers from the bike.")
                button("RETRY") { load() }
            } else showAuthorization()
        }
    }

    private fun showAuthorization() {
        resetRows()
        label("Manage Ollama, LOBO or another OpenAI-compatible server.", 19f, Color.WHITE)
        label("Generate a one-time administrator code on your Transcriber server:")
        label("docker compose exec transcriber python -m transcriber summary-admin", 15f, ACCENT)
        label("The code expires after 10 minutes and is single-use.")
        if (connection.address.startsWith("http://")) {
            label("This connection uses HTTP. Continue only on a trusted private network. New provider API keys require HTTPS to Transcriber.", 15f, ACCENT)
        }
        val code = field("Administrator code (XXXX-XXXX)", 9, secret = true)
        button("AUTHORIZE", true) {
            val entered = code.text.toString()
            request("Authorizing…", { api.authorize(entered) }) {
                current = it
                showConfiguration()
            }
        }
    }

    private fun showConfiguration() {
        resetRows()
        val active = requireNotNull(current)
        status.text = if (active.configured) "Active model: ${active.model}" else "Summarization disabled"
        if (active.storageError) label("Saved settings could not be loaded. Save a new provider to recover.", 15f, ACCENT)
        if (active.configured) {
            label("Current endpoint", 18f, Color.WHITE)
            label(requireNotNull(active.baseUrl))
            label(if (active.customCa) "Private CA configured" else "Standard certificate trust")
            button("USE CURRENT PROVIDER") {
                request("Discovering models…", { api.discoverCurrent() }) { showModels(it) }
            }
        }
        label("Choose a provider", 20f, Color.WHITE)
        val kinds = listOf("Ollama", "LOBO", "OpenAI-compatible")
        val kind = spinner(kinds)
        val endpoint = field("Provider base URL ending in /v1", 2048)
        endpoint.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        val auth = field("LOBO AUTH code (XXXX-XXXX)", 9, secret = true)
        val key = field("Provider API key (optional)", 2048, secret = true)
        val allowHttp = CheckBox(context).apply {
            text = "Allow unencrypted HTTP to provider"
            setTextColor(Color.WHITE)
        }
        rows.addView(allowHttp)
        val hint = label("", 15f, ACCENT)
        fun configure(position: Int) {
            clearSecrets()
            endpoint.setText("")
            endpoint.hint = when (position) {
                0 -> "http://ollama-host:11434/v1"
                1 -> "https://192.168.1.200:7869/v1"
                else -> "https://server.example/v1"
            }
            auth.visibility = if (position == 1) View.VISIBLE else View.GONE
            key.visibility = if (position != 1 && connection.address.startsWith("https://")) View.VISIBLE else View.GONE
            allowHttp.visibility = if (position == 1) View.GONE else View.VISIBLE
            allowHttp.isChecked = false
            hint.text = when (position) {
                0 -> "Use an address reachable from Transcriber, not from the bike."
                1 -> "Enter the Pixel's private IPv4 address and the AUTH code displayed by LOBO."
                else -> "For a custom private CA, configure it on the server and use Current provider."
            }
        }
        kind.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                configure(position)
            }
        }
        configure(0)
        button("DISCOVER MODELS", true) {
            val selected = listOf("ollama", "lobo", "custom")[kind.selectedItemPosition]
            val url = endpoint.text.toString()
            val http = allowHttp.isChecked
            val secret = key.text.toString()
            val loboAuth = auth.text.toString()
            request("Discovering models…", { api.discoverNew(selected, url, http, secret, loboAuth) }) { showModels(it) }
        }
        if (active.configured) button("DISABLE SUMMARIZATION") {
            AlertDialog.Builder(context).setTitle("Disable summarization?")
                .setMessage("Summary and recap generation will be disabled for all connected bikes. Transcription and playback remain available.")
                .setNegativeButton("CANCEL", null)
                .setPositiveButton("DISABLE") { _, _ ->
                    request("Disabling…", { api.disable() }) { finish(it) }
                }.show()
        }
        button("CANCEL ADMIN SESSION") { cancelSession() }
    }

    private fun showModels(discovery: SummaryProviderDiscovery) {
        resetRows()
        tested = null
        status.text = "Provider discovered"
        label(requireNotNull(discovery.candidate.baseUrl), 18f, Color.WHITE)
        label("Choose a model and test it with a synthetic excerpt. No audiobook text is sent during this test.")
        val modelSpinner = if (discovery.models.isNotEmpty()) spinner(discovery.models) else null
        val manual = if (modelSpinner == null) field("Model identifier", 160) else null
        if (modelSpinner != null) {
            val index = discovery.models.indexOf(current?.model)
            if (index >= 0) modelSpinner.setSelection(index)
        }
        fun selectedModel(): String = modelSpinner?.selectedItem?.toString() ?: manual?.text.toString().trim()
        val result = label("Not tested", 17f, Color.LTGRAY)
        val testButton = button("TEST INFERENCE", true) {
            val model = selectedModel()
            tested = null
            result.text = "Testing…"
            request("Running inference…", { api.test(model) }, onFailure = {
                result.text = "Test failed. Retry or choose another model."
                result.setTextColor(Color.LTGRAY)
            }) { elapsed ->
                tested = model
                result.text = "Test passed · " + String.format(Locale.US, "%.2f s", elapsed / 1000.0)
                result.setTextColor(ACCENT)
                status.text = "Ready to save"
                renderSaveState()
            }
        }
        val consent = CheckBox(context).apply {
            text = "Allow requested audiobook excerpts to be sent to this provider"
            setTextColor(Color.WHITE)
        }
        rows.addView(consent)
        val save = button("SAVE PROVIDER", true) {
            if (tested != selectedModel() || !consent.isChecked) return@button
            val expected = requireNotNull(tested)
            request("Saving provider…", { api.save() }) {
                if (it.model == expected) finish(it)
                else {
                    resetRows()
                    status.text = "Provider changed unexpectedly. Reopen to verify current settings."
                    button("RELOAD") { load() }
                }
            }
        }
        updateSave = {
            save.isEnabled = pending == null && tested != null && tested == selectedModel() && consent.isChecked
        }
        consent.setOnCheckedChangeListener { _, _ -> renderSaveState() }
        fun changed() {
            tested = null
            result.text = "Not tested"
            result.setTextColor(Color.LTGRAY)
            consent.isChecked = false
            renderSaveState()
        }
        modelSpinner?.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = changed()
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (tested != selectedModel()) changed()
            }
        }
        manual?.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = changed()
            override fun afterTextChanged(s: android.text.Editable?) = Unit
        })
        testButton.isEnabled = true
        renderSaveState()
        button("CHANGE PROVIDER") { showConfiguration() }
        button("CANCEL ADMIN SESSION") { cancelSession() }
    }

    private var updateSave: (() -> Unit)? = null
    private fun renderSaveState() { updateSave?.invoke() }

    private fun cancelSession() {
        request("Closing administrator session…", { api.cancel() }) { load() }
    }

    private fun finish(value: SummaryProviderStatus) {
        current = value
        resetRows()
        status.text = if (value.configured) "Saved · ${value.model}" else "Summarization disabled"
        label("Changes are active on Transcriber. Reopen an audiobook to refresh its provider information.", 18f, ACCENT)
        button("DONE", true) { dialog.dismiss() }
        button("MANAGE AGAIN") { load() }
    }

    private fun <T> request(message: String, action: () -> T, onFailure: () -> Unit = {}, success: (T) -> Unit) {
        if (closed || pending != null) return
        status.text = message
        enableRows(false)
        pending = worker.submit {
            val result = runCatching(action)
            main.post {
                if (closed) return@post
                pending = null
                enableRows(true)
                renderSaveState()
                result.fold(success) { error ->
                    onFailure()
                    status.text = failureMessage(error)
                    if (error is SummaryManagementFailure && error.code in setOf("summary_admin_unavailable", "invalid_summary_admin_code", "unauthorized")) {
                        api.forgetGrant()
                        showAuthorization()
                    }
                    renderSaveState()
                }
            }
        }
    }

    private fun failureMessage(error: Throwable): String = when (error) {
        is SummaryManagementFailure -> when (error.code) {
            "lobo_auth_mismatch" -> "LOBO AUTH code does not match this phone."
            "lobo_certificate_unavailable" -> "Unable to retrieve LOBO's certificate. Check its address."
            "lobo_private_ipv4_required" -> "LOBO requires a private IPv4 HTTPS address on port 7869 ending in /v1."
            "invalid_summary_admin_code" -> "Invalid administrator code. Try again."
            "summary_admin_unavailable", "unauthorized" -> "Administrator session expired or rejected. Generate a new code."
            "summary_busy" -> "Transcriber is busy with another summary. Retry."
            "provider_authentication" -> "Provider rejected its credentials."
            "provider_timeout" -> "Provider inference timed out."
            "provider_unavailable" -> "Cannot reach or verify the provider. Check address and TLS trust."
            "provider_http_error" -> "Provider rejected the request. Check endpoint and model."
            "provider_rate_limited" -> "Provider rate limited the request. Retry."
            "invalid_completion", "invalid_response" -> "Provider returned an incompatible response."
            "summary_model_not_discovered" -> "Select a discovered model."
            else -> "Provider management failed (HTTP ${error.status})."
        }
        is IllegalArgumentException -> "Check endpoint, model, credentials and HTTP settings."
        else -> "Request failed. Check Transcriber connection. If Save was attempted, reopen to check the active model."
    }

    private fun clearSecrets() { secretFields.forEach { it.text.clear() } }

    private fun resetRows() {
        clearSecrets()
        secretFields.clear()
        updateSave = null
        tested = null
        rows.removeAllViews()
        scroll.scrollTo(0, 0)
    }

    private fun enableRows(enabled: Boolean) {
        fun visit(view: View) {
            view.isEnabled = enabled
            if (view is ViewGroup) for (i in 0 until view.childCount) visit(view.getChildAt(i))
        }
        visit(rows)
    }

    private fun label(value: String, size: Float = 16f, color: Int = Color.LTGRAY): TextView =
        TextView(context).apply {
            text = value
            textSize = size
            setTextColor(color)
            setPadding(0, dp(8), 0, dp(4))
            rows.addView(this, LinearLayout.LayoutParams(-1, -2))
        }

    private fun field(hintText: String, limit: Int, secret: Boolean = false): EditText =
        EditText(context).apply {
            hint = hintText
            setSingleLine(true)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.LTGRAY)
            filters = arrayOf(InputFilter.LengthFilter(limit))
            isSaveEnabled = false
            if (secret) {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                secretFields.add(this)
            }
            rows.addView(this, LinearLayout.LayoutParams(-1, dp(56)))
        }

    private fun spinner(values: List<String>): Spinner = Spinner(context).apply {
        adapter = ArrayAdapter(context, android.R.layout.simple_spinner_dropdown_item, values)
        rows.addView(this, LinearLayout.LayoutParams(-1, dp(56)))
    }

    private fun button(value: String, primary: Boolean = false, action: () -> Unit): Button =
        Button(context).apply {
            text = value
            setTextColor(if (primary) Color.BLACK else Color.WHITE)
            setBackgroundColor(if (primary) ACCENT else 0xff2c3b4d.toInt())
            setOnClickListener { if (!closed && pending == null) action() }
            rows.addView(this, LinearLayout.LayoutParams(-1, dp(48)).apply {
                setMargins(0, dp(6), 0, dp(4))
            })
        }

    private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density + 0.5f).toInt()

    private companion object { val ACCENT = 0xffffce1b.toInt() }
}
