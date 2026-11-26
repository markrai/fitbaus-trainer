package com.fitbaus.bikebridge.host.books

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.content.res.ColorStateList
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
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
    private val loboDiscovery = LoboLanDiscovery(context)
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val rows = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(8), dp(20), dp(16))
    }
    private val status = TextView(context).apply {
        textSize = 16f
        setTextColor(MUTED)
        setPadding(dp(20), dp(4), dp(20), dp(6))
    }
    private val scroll = ScrollView(context).apply {
        isFillViewport = true
        addView(rows)
    }
    private val dialog = AlertDialog.Builder(context)
        .setView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
            val header = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(20), dp(8), dp(12), 0)
            }
            header.addView(TextView(context).apply {
                text = "Summarization provider"
                textSize = 24f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.WHITE)
            }, LinearLayout.LayoutParams(0, -2, 1f))
            header.addView(Button(context).apply {
                text = "CLOSE"
                setTextColor(Color.WHITE)
                background = surface(CARD, BORDER)
                setOnClickListener { closeDialog() }
            }, LinearLayout.LayoutParams(dp(112), dp(44)))
            addView(header)
            addView(status)
            addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        })
        .create()
    private var pending: Future<*>? = null
    private var closed = false
    private var current: SummaryProviderStatus? = null
    private var activeModel: String? = null
    private var tested: String? = null
    private var secretFields = mutableListOf<EditText>()

    private fun closeDialog() { if (!closed) dialog.dismiss() }

    fun show(): AlertDialog {
        dialog.setOnDismissListener {
            closed = true
            loboDiscovery.stop()
            hideKeyboard()
            clearSecrets()
            api.forgetGrant()
            pending?.cancel(true)
            worker.shutdownNow()
        }
        dialog.show()
        configureInputWindow()
        load()
        return dialog
    }

    @Suppress("DEPRECATION")
    private fun configureInputWindow() {
        dialog.window?.apply {
            setLayout(-1, -1)
            clearFlags(WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or
                WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        }
    }

    private fun load() {
        current = null
        activeModel = null
        resetRows()
        button("RETRY") { load() }
        request("Checking server…", { api.capabilities() }) { (supported, model) ->
            activeModel = model
            status.text = activeStatus()
            if (!supported) {
                resetRows()
                label("Update FitBaus Transcriber to manage providers from the bike.")
                button("RETRY") { load() }
            } else showAuthorization()
        }
    }

    private fun activeStatus(): String = activeModel?.let { "Active model: $it" }
        ?: "Summarization disabled or unavailable"

    private fun showAuthorization() {
        current = null
        showConfiguration()
    }

    private fun showConfiguration() {
        resetRows()
        status.text = activeStatus()

        val form = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(10), dp(16), dp(12))
            background = surface(CARD, BORDER)
        }
        rows.addView(form, LinearLayout.LayoutParams(-1, -2))
        label("Provider", 15f, MUTED, form)
        val kinds = listOf("ollama", "lobo", "custom")
        val names = listOf("Ollama", "LOBO", "Custom")
        val providerRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        form.addView(providerRow, LinearLayout.LayoutParams(-1, dp(48)))
        val choices = mutableListOf<Button>()
        var currentChoice: Button? = null
        var selected = -1
        var usingCurrent = false
        var discovery: SummaryProviderDiscovery? = null
        var model: String? = null

        val loboPanel = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        form.addView(loboPanel, LinearLayout.LayoutParams(-1, -2))
        val lanStatus = label("Finding LOBO devices…", 15f, MUTED, loboPanel)
        val lanDevices = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        loboPanel.addView(lanDevices, LinearLayout.LayoutParams(-1, -2))
        val manualAddress = button("ENTER ADDRESS MANUALLY", parent = loboPanel) {}
        val endpointLabel = label("Provider address", 15f, MUTED, form)
        val endpoint = field("Provider base URL ending in /v1", 2048, parent = form)
        endpoint.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        val authLabel = label("LOBO AUTH code", 15f, MUTED, form)
        val auth = field("XXXX-XXXX", 9, secret = true, parent = form)
        val keyLabel = label("Provider API key (optional)", 15f, MUTED, form)
        val key = field("API key", 2048, secret = true, parent = form)
        val allowHttp = CheckBox(context).apply {
            text = "Allow unencrypted HTTP to provider"
            setTextColor(Color.WHITE)
            buttonTintList = ColorStateList.valueOf(ACCENT)
        }
        form.addView(allowHttp)
        val hint = label("", 14f, MUTED, form)
        val authorization = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(6), dp(12), dp(8))
            background = surface(BACKGROUND, BORDER)
        }
        form.addView(authorization, LinearLayout.LayoutParams(-1, -2).apply {
            setMargins(0, dp(8), 0, dp(4))
        })
        label("Administrator authorization", 16f, Color.WHITE, authorization)
        label("Generate a one-time code on your Transcriber server.", 14f, MUTED, authorization)
        label("docker compose exec transcriber python -m transcriber summary-admin", 14f, ACCENT, authorization)
        if (connection.address.startsWith("http://")) {
            label("HTTP connection: use a trusted private network. New provider API keys require HTTPS.", 13f, MUTED, authorization)
        }
        val adminCode = field("Administrator code (XXXX-XXXX)", 9, secret = true, parent = authorization)
        val authorizeButton = button("AUTHORIZE", true, authorization) {}
        val discoverButton = button("DISCOVER MODELS", parent = form) {}
        val modelPanel = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        form.addView(modelPanel, LinearLayout.LayoutParams(-1, -2))
        val placeholder = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        form.addView(placeholder, LinearLayout.LayoutParams(-1, -2))
        label("Model", 15f, MUTED, placeholder)
        label("Discover models to select one", 16f, MUTED, placeholder).apply {
            background = surface(FIELD, BORDER)
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        val placeholderTest = button("TEST INFERENCE", parent = placeholder) {}
        val placeholderSave = button("SAVE PROVIDER", true, placeholder) {}
        placeholderTest.alpha = 0.4f
        placeholderSave.alpha = 0.4f
        val consent = CheckBox(context).apply {
            text = "Allow requested audiobook excerpts to be sent to this provider"
            setTextColor(Color.WHITE)
            buttonTintList = ColorStateList.valueOf(ACCENT)
        }
        val save = Button(context).apply {
            text = "SAVE PROVIDER"
            setTextColor(Color.BLACK)
            background = surface(ACCENT, ACCENT)
            isEnabled = false
            alpha = 0.4f
        }
        var suppressChanges = false
        var manualLobo = false
        val lanSelection = LoboLanPickerState()
        val lanButtons = linkedMapOf<String, Button>()
        var scanningLan = false
        var failedLan = false
        var reuseButton: Button? = null
        val authorizationLabel = TextView(context).apply {
            textSize = 14f
            setTextColor(SUCCESS)
            visibility = View.GONE
        }
        form.addView(authorizationLabel, form.indexOfChild(discoverButton), LinearLayout.LayoutParams(-1, -2))

        fun invalidateTest() {
            tested = null
            consent.isChecked = false
            renderSaveState()
        }

        fun invalidateDiscovery() {
            discovery = null
            model = null
            (consent.parent as? ViewGroup)?.removeView(consent)
            (save.parent as? ViewGroup)?.removeView(save)
            modelPanel.removeAllViews()
            modelPanel.visibility = View.GONE
            placeholder.visibility = View.VISIBLE
            invalidateTest()
        }

        fun renderChoices() {
            currentChoice?.let {
                it.isSelected = usingCurrent
                it.setTextColor(if (usingCurrent) ACCENT else Color.WHITE)
                it.background = surface(if (usingCurrent) 0xff342f1c.toInt() else FIELD,
                    if (usingCurrent) ACCENT else BORDER, if (usingCurrent) 2 else 1)
            }
            choices.forEachIndexed { index, choice ->
                val chosen = !usingCurrent && selected == index
                choice.isSelected = chosen
                choice.setTextColor(if (chosen) ACCENT else Color.WHITE)
                choice.background = surface(if (chosen) 0xff342f1c.toInt() else FIELD, if (chosen) ACCENT else BORDER,
                    if (chosen) 2 else 1)
            }
        }

        fun renderLanDevices() {
            val picked = lanSelection.selected
            lanStatus.text = when {
                picked != null -> if (lanSelection.isAvailable(picked.address))
                    "Selected: ${picked.name} · Unverified"
                    else "Selected: ${picked.name} · Last seen, not currently advertised"
                scanningLan -> "Finding LOBO devices…"
                failedLan -> "Discovery unavailable"
                lanSelection.devices.isEmpty() -> "No LOBO devices found. Check the LAN or enter the address manually."
                else -> "${lanSelection.devices.size} LOBO device(s) found · Unverified"
            }
            val visible = lanSelection.rows()
            val addresses = visible.map { it.address }.toSet()
            for (address in lanButtons.keys.toList()) {
                if (address !in addresses) {
                    lanButtons.remove(address)?.let { lanDevices.removeView(it) }
                }
            }
            visible.forEach { device ->
                val address = device.address
                val chosen = picked?.address == address
                val row = lanButtons.getOrPut(address) {
                    button("", parent = lanDevices) {
                        if (lanSelection.selected?.address != address || manualLobo) {
                            val chosenDevice = lanSelection.select(address)
                            if (chosenDevice != null) {
                                manualLobo = false
                                endpoint.setText(chosenDevice.endpoint)
                                auth.text.clear()
                                endpoint.visibility = View.GONE
                                endpointLabel.visibility = View.GONE
                                manualAddress.text = "ENTER ADDRESS MANUALLY"
                                renderLanDevices()
                            }
                        }
                    }.apply {
                        isAllCaps = false
                        backgroundTintList = null
                    }
                }
                row.text = if (chosen) "${device.name}  ·  ${device.address}  ·  SELECTED"
                    else "${device.name}  ·  ${device.address}"
                row.isSelected = chosen
                row.isEnabled = pending == null
                row.setTextColor(if (chosen) ACCENT else Color.WHITE)
                row.background = surface(if (chosen) 0xff342f1c.toInt() else FIELD,
                    if (chosen) ACCENT else BORDER, if (chosen) 2 else 1)
            }
        }

        fun scanLan() {
            if (closed || pending != null || selected != 1 || usingCurrent) return
            loboDiscovery.start { devices, scanning, failed ->
                if (!closed && selected == 1 && !usingCurrent) {
                    lanSelection.update(devices)
                    scanningLan = scanning
                    failedLan = failed
                    renderLanDevices()
                }
            }
        }

        fun configure(position: Int, reuse: Boolean = false) {
            suppressChanges = true
            loboDiscovery.stop()
            lanSelection.reset()
            lanButtons.clear()
            lanDevices.removeAllViews()
            scanningLan = false
            failedLan = false
            manualLobo = false
            selected = position
            usingCurrent = reuse
            invalidateDiscovery()
            auth.text.clear()
            key.text.clear()
            endpoint.isEnabled = !reuse
            endpoint.setText(if (reuse) current?.baseUrl.orEmpty() else "")
            endpoint.hint = when (position) {
                0 -> "http://ollama-host:11434/v1"
                1 -> "https://192.168.1.200:7869/v1"
                else -> "https://server.example/v1"
            }
            val showAuth = !reuse && position == 1
            loboPanel.visibility = if (showAuth) View.VISIBLE else View.GONE
            endpointLabel.visibility = if (showAuth) View.GONE else View.VISIBLE
            endpoint.visibility = endpointLabel.visibility
            manualAddress.text = "ENTER ADDRESS MANUALLY"
            authLabel.visibility = if (showAuth) View.VISIBLE else View.GONE
            auth.visibility = authLabel.visibility
            val showKey = !reuse && position != 1 && connection.address.startsWith("https://")
            keyLabel.visibility = if (showKey) View.VISIBLE else View.GONE
            key.visibility = keyLabel.visibility
            allowHttp.visibility = if (!reuse && position != 1) View.VISIBLE else View.GONE
            allowHttp.isChecked = reuse && current?.allowHttp == true
            hint.text = when {
                reuse -> "Reuse the active endpoint, credentials and certificate trust."
                position == 0 -> "Address must be reachable from Transcriber."
                position == 1 -> "Select a phone, then enter the AUTH code shown on that phone. Discovery does not verify identity."
                else -> "Custom private CAs can be configured on the server and reused here."
            }
            discoverButton.text = if (reuse) "DISCOVER CURRENT MODELS" else "DISCOVER MODELS"
            renderChoices()
            suppressChanges = false
            if (showAuth) scanLan()
        }

        fun showDiscovered(value: SummaryProviderDiscovery) {
            invalidateDiscovery()
            discovery = value
            modelPanel.visibility = View.VISIBLE
            placeholder.visibility = View.GONE
            label("Model", 15f, MUTED, modelPanel)
            val result = TextView(context).apply {
                text = "Not tested"
                textSize = 15f
                setTextColor(MUTED)
                setPadding(0, dp(4), 0, dp(4))
            }
            fun changed(value: String?) {
                if (model == value) return
                model = value
                invalidateTest()
                result.text = "Not tested"
                result.setTextColor(MUTED)
            }
            if (value.models.isEmpty()) {
                val manual = field("Model identifier", 160, parent = modelPanel)
                watch(manual) { changed(manual.text.toString().trim()) }
            } else {
                val models = spinner(value.models, modelPanel)
                val index = value.models.indexOf(activeModel).coerceAtLeast(0)
                models.setSelection(index)
                model = value.models[index]
                models.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                    override fun onNothingSelected(parent: AdapterView<*>?) = changed(null)
                    override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                        changed(value.models[position])
                    }
                }
            }
            button("TEST INFERENCE", parent = modelPanel) {
                val selectedModel = model.orEmpty()
                invalidateTest()
                result.text = "Testing…"
                request("Running inference…", { api.test(selectedModel) }, onFailure = {
                    result.text = "Test failed. Retry or choose another model."
                    result.setTextColor(MUTED)
                }) { elapsed ->
                    tested = selectedModel
                    result.text = "Test passed · " + String.format(Locale.US, "%.2f s", elapsed / 1000.0)
                    result.setTextColor(SUCCESS)
                    status.text = "Ready to save"
                    renderSaveState()
                }
            }
            modelPanel.addView(result)
            modelPanel.addView(consent)
            modelPanel.addView(save, LinearLayout.LayoutParams(-1, dp(48)).apply {
                setMargins(0, dp(6), 0, dp(2))
            })
            renderSaveState()
        }

        updateSave = {
            val idle = pending == null
            endpoint.isEnabled = idle && !usingCurrent
            discoverButton.isEnabled = idle && current != null &&
                (selected != 1 || usingCurrent || endpoint.text.isNotBlank())
            discoverButton.alpha = if (discoverButton.isEnabled) 1f else 0.4f
            reuseButton?.isEnabled = idle && current?.configured == true
            authorizeButton.isEnabled = idle && current == null
            placeholderTest.isEnabled = false
            placeholderSave.isEnabled = false
            val enabled = pending == null && discovery != null && tested != null && tested == model && consent.isChecked
            save.isEnabled = enabled
            save.alpha = if (enabled) 1f else 0.4f
        }
        consent.setOnCheckedChangeListener { _, _ -> renderSaveState() }
        save.setOnClickListener {
            if (closed || pending != null || tested == null || tested != model || !consent.isChecked) return@setOnClickListener
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
        names.forEachIndexed { index, name ->
            val choice = Button(context).apply {
                text = name
                isAllCaps = false
                textSize = 16f
                setOnClickListener { if (!closed && pending == null && (selected != index || usingCurrent)) configure(index) }
            }
            choices.add(choice)
            providerRow.addView(choice, LinearLayout.LayoutParams(0, -1, 1f).apply {
                setMargins(if (index == 0) 0 else dp(4), 0, if (index == names.lastIndex) 0 else dp(4), 0)
            })
        }
        currentChoice = button("USE CURRENT PROVIDER", parent = form, index = 2) { configure(-1, true) }
        reuseButton = currentChoice
        currentChoice?.visibility = if (current?.configured == true) View.VISIBLE else View.GONE
        manualAddress.setOnClickListener {
            if (closed || pending != null) return@setOnClickListener
            manualLobo = !manualLobo
            lanSelection.clearSelection()
            endpoint.text.clear()
            auth.text.clear()
            endpoint.visibility = if (manualLobo) View.VISIBLE else View.GONE
            endpointLabel.visibility = endpoint.visibility
            manualAddress.text = if (manualLobo) "CHOOSE DISCOVERED DEVICE" else "ENTER ADDRESS MANUALLY"
            renderLanDevices()
        }
        listOf(endpoint, auth, key).forEach { edit -> watch(edit) { if (!suppressChanges) invalidateDiscovery() } }
        allowHttp.setOnCheckedChangeListener { _, _ -> if (!suppressChanges) invalidateDiscovery() }
        discoverButton.setOnClickListener {
            if (closed || pending != null || current == null) return@setOnClickListener
            if (selected == 1 && !usingCurrent && endpoint.text.isBlank()) return@setOnClickListener
            val reuse = usingCurrent
            val url = endpoint.text.toString()
            val http = allowHttp.isChecked
            val secret = key.text.toString()
            val loboAuth = auth.text.toString()
            val kind = kinds.getOrNull(selected)
            invalidateDiscovery()
            request("Discovering models…", {
                if (reuse) api.discoverCurrent() else api.discoverNew(requireNotNull(kind), url, http, secret, loboAuth)
            }) { showDiscovered(it) }
        }
        configure(0)
        val disableButton = button("DISABLE SUMMARIZATION") {
            AlertDialog.Builder(context).setTitle("Disable summarization?")
                .setMessage("Summary and recap generation will be disabled for all connected bikes. Transcription and playback remain available.")
                .setNegativeButton("CANCEL", null)
                .setPositiveButton("DISABLE") { _, _ -> request("Disabling…", { api.disable() }) { finish(it) } }
                .show()
        }
        val cancelButton = button("CANCEL ADMIN SESSION") { cancelSession() }
        fun refreshAuthorization() {
            val authorized = current != null
            authorization.visibility = if (authorized) View.GONE else View.VISIBLE
            authorizationLabel.visibility = if (authorized) View.VISIBLE else View.GONE
            authorizationLabel.text = if (current?.storageError == true)
                "Authorized · Saved settings could not be loaded. Save a provider to recover."
                else "Administrator authorized"
            currentChoice?.visibility = if (current?.configured == true) View.VISIBLE else View.GONE
            disableButton.visibility = if (current?.configured == true) View.VISIBLE else View.GONE
            cancelButton.visibility = if (authorized) View.VISIBLE else View.GONE
            renderSaveState()
        }
        authorizeButton.setOnClickListener {
            if (closed || pending != null || current != null) return@setOnClickListener
            val entered = adminCode.text.toString()
            request("Authorizing…", { api.authorize(entered) }) { value ->
                current = value
                activeModel = value.model
                adminCode.text.clear()
                status.text = activeStatus()
                if (selected != 1 && endpoint.text.isBlank() && value.configured) configure(-1, true)
                refreshAuthorization()
            }
        }
        refreshAuthorization()
    }

    private fun watch(edit: EditText, changed: () -> Unit) {
        edit.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = changed()
            override fun afterTextChanged(s: Editable?) = Unit
        })
    }

    private var updateSave: (() -> Unit)? = null
    private fun renderSaveState() { updateSave?.invoke() }

    private fun cancelSession() {
        request("Closing administrator session…", { api.cancel() }, onFailure = {
            api.forgetGrant()
            showAuthorization()
        }) { load() }
    }

    private fun finish(value: SummaryProviderStatus) {
        current = null
        activeModel = value.model
        resetRows()
        status.text = if (value.configured) "Saved · ${value.model}" else "Summarization disabled"
        label("Changes are active on Transcriber. Reopen an audiobook to refresh its provider information.", 18f, ACCENT)
        button("DONE", true) { dialog.dismiss() }
        button("MANAGE AGAIN") { load() }
    }

    private fun <T> request(message: String, action: () -> T, onFailure: () -> Unit = {}, success: (T) -> Unit) {
        if (closed || pending != null) return
        status.text = message
        hideKeyboard()
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
                    if (error is SummaryManagementFailure && error.code in setOf("summary_admin_unavailable", "unauthorized")) {
                        api.forgetGrant()
                        showAuthorization()
                        status.text = failureMessage(error)
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

    private fun inputMethod(): InputMethodManager? =
        context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager

    private fun hideKeyboard() {
        val focused = dialog.currentFocus as? EditText ?: return
        focused.windowToken?.let { inputMethod()?.hideSoftInputFromWindow(it, 0) }
        focused.clearFocus()
    }

    private fun showKeyboard(editor: EditText) {
        if (closed || !editor.isEnabled || !editor.isShown) return
        dialog.window?.clearFlags(WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM or
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
        if (!editor.requestFocus()) return
        editor.post {
            if (!closed && editor.isEnabled && editor.isShown && editor.hasFocus() && editor.hasWindowFocus()) {
                inputMethod()?.showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT)
            }
        }
    }

    private fun clearSecrets() { secretFields.forEach { it.text.clear() } }

    private fun resetRows() {
        loboDiscovery.stop()
        updateSave = null
        clearSecrets()
        secretFields.clear()
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

    private fun label(value: String, size: Float = 16f, color: Int = MUTED,
                      parent: LinearLayout = rows): TextView =
        TextView(context).apply {
            text = value
            textSize = size
            setTextColor(color)
            setPadding(0, dp(8), 0, dp(4))
            parent.addView(this, LinearLayout.LayoutParams(-1, -2))
        }

    private fun field(hintText: String, limit: Int, secret: Boolean = false,
                      parent: LinearLayout = rows): EditText =
        EditText(context).apply {
            hint = hintText
            setSingleLine(true)
            isFocusable = true
            isFocusableInTouchMode = true
            setOnClickListener { showKeyboard(this) }
            setTextColor(Color.WHITE)
            setHintTextColor(MUTED)
            textSize = 16f
            setPadding(dp(12), 0, dp(12), 0)
            background = surface(FIELD, BORDER)
            filters = arrayOf(InputFilter.LengthFilter(limit))
            isSaveEnabled = false
            if (secret) {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                secretFields.add(this)
            }
            parent.addView(this, LinearLayout.LayoutParams(-1, dp(48)))
        }

    private fun spinner(values: List<String>, parent: LinearLayout = rows): Spinner = Spinner(context).apply {
        adapter = object : ArrayAdapter<String>(context, android.R.layout.simple_spinner_dropdown_item, values) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                super.getView(position, convertView, parent).also { (it as TextView).setTextColor(Color.WHITE) }
        }
        setPadding(dp(12), 0, dp(12), 0)
        backgroundTintList = ColorStateList.valueOf(MUTED)
        parent.addView(this, LinearLayout.LayoutParams(-1, dp(48)))
    }

    private fun button(value: String, primary: Boolean = false, parent: LinearLayout = rows,
                       index: Int = -1, action: () -> Unit): Button =
        Button(context).apply {
            text = value
            setTextColor(if (primary) Color.BLACK else Color.WHITE)
            background = surface(if (primary) ACCENT else FIELD, if (primary) ACCENT else BORDER)
            setOnClickListener { if (!closed && pending == null) action() }
            parent.addView(this, index, LinearLayout.LayoutParams(-1, dp(48)).apply {
                setMargins(0, dp(6), 0, dp(4))
            })
        }

    private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density + 0.5f).toInt()

    private fun surface(fill: Int, stroke: Int, width: Int = 1) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(8).toFloat()
        setStroke(dp(width), stroke)
    }

    private companion object {
        val ACCENT = 0xffffce1b.toInt()
        val BACKGROUND = 0xff101720.toInt()
        val CARD = 0xff1a2330.toInt()
        val FIELD = 0xff263341.toInt()
        val BORDER = 0xff455368.toInt()
        val MUTED = 0xffc1cbd7.toInt()
        val SUCCESS = 0xff58d5a5.toInt()
    }
}
