package com.fitbaus.bikebridge.host.books

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
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
import com.fitbaus.bikebridge.host.ui.NativeDialogStyle
import com.fitbaus.bikebridge.host.ui.NativeDialogViews
import com.fitbaus.bikebridge.host.ui.setDialogTreeEnabled
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal class SummaryProviderDialog(
    private val context: Context,
    private val connection: TranscriberConnection,
) {
    private val workflow = SummaryProviderWorkflow()
    private val actions = SummaryProviderActions(workflow, SummaryProviderManagement(connection))
    private val state get() = workflow.state
    private val loboDiscovery = LoboLanDiscovery(context)
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val views = NativeDialogViews(context, NativeDialogStyle.SUMMARY_PROVIDER)
    private val rows = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(8), dp(20), dp(16))
    }
    private val status = TextView(context).apply {
        textSize = 16f
        setTextColor(MUTED)
        setPadding(dp(20), dp(4), dp(20), dp(6))
    }
    private var embedded = false
    private val scroll by lazy { ScrollView(context).apply {
        isFillViewport = true
        addView(rows)
    } }
    private val dialog by lazy { AlertDialog.Builder(context)
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
        .create() }
    private var pendingWork: Future<*>? = null
    private var confirmation: AlertDialog? = null
    private val closed get() = state.screen == SummaryProviderScreen.CLOSED
    private var formGeneration = 0
    private val secretFields = mutableListOf<EditText>()

    private fun closeDialog() { if (!closed && !embedded) dialog.dismiss() }

    fun show(): AlertDialog {
        dialog.setOnDismissListener { close() }
        dialog.show()
        configureInputWindow()
        load()
        return dialog
    }

    fun attach(parent: LinearLayout) {
        check(!closed && !embedded)
        embedded = true
        rows.setPadding(0, dp(4), 0, dp(8))
        status.setPadding(dp(4), dp(4), dp(4), dp(6))
        parent.addView(status)
        parent.addView(rows, LinearLayout.LayoutParams(-1, -2))
        load()
    }

    fun close() {
        if (closed) return
        actions.close()
        formGeneration++
        confirmation?.dismiss()
        confirmation = null
        loboDiscovery.stop()
        hideKeyboard()
        clearSecrets()
        secretFields.clear()
        renderConfiguration = null
        pendingWork?.cancel(true)
        pendingWork = null
        worker.shutdownNow()
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
        if (closed || !state.idle) return
        resetRows()
        button("RETRY") { load() }
        request(actions.capabilities(), "Checking server…") {
            status.text = activeStatus()
            if (state.screen == SummaryProviderScreen.UNSUPPORTED) {
                resetRows()
                label("Update FitBaus Transcriber to manage providers from the bike.")
                button("RETRY") { load() }
            } else if (state.canOpen) {
                showConfiguration()
                request(actions.open(), "Connecting to Transcriber…", onFailure = { showConfiguration() }) {
                    showConfiguration()
                }
            } else showConfiguration()
        }
    }

    private fun activeStatus(): String = "Saved provider · " + summaryProviderPresentation(state).activeTitle

    private fun showConfiguration(openAuthorization: Boolean = false) {
        resetRows()
        status.text = if (state.automaticActivation) "Choose a provider to activate." else "Choose a provider and unlock changes when ready."
        val activeCard = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = surface(CARD, BORDER)
            setPadding(dp(16), dp(8), dp(16), dp(10))
        }
        rows.addView(activeCard, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) })
        label("CURRENTLY SAVED", 13f, MUTED, activeCard)
        val activeTitle = label("", 21f, Color.WHITE, activeCard)
        val activeDetail = label("", 14f, MUTED, activeCard)
        val generation = formGeneration
        fun formCurrent() = generation == formGeneration && state.screen == SummaryProviderScreen.CONFIGURATION

        var advanced = openAuthorization
        val form = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(10), dp(16), dp(12))
            background = surface(CARD, BORDER)
        }
        rows.addView(form, LinearLayout.LayoutParams(-1, -2))
        label("Provider", 15f, MUTED, form)
        if (state.automaticActivation) label("Selecting a provider and model tests and activates it for audiobook summaries on this server. First-use LOBO certificate trust is for trusted LANs only.", 13f, MUTED, form)
        val kinds = listOf(SummaryProviderChoice.OLLAMA, SummaryProviderChoice.LOBO, SummaryProviderChoice.CUSTOM)
        val names = listOf("Ollama", "LOBO", "Custom")
        val providerRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        form.addView(providerRow, LinearLayout.LayoutParams(-1, dp(48)))
        val choices = mutableListOf<Button>()
        var currentChoice: Button? = null
        var testButton: Button? = null
        var discoverDraft: (() -> Unit)? = null

        val loboPanel = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        form.addView(loboPanel, LinearLayout.LayoutParams(-1, -2))
        val lanStatus = label("Finding LOBO devices…", 15f, MUTED, loboPanel)
        val lanDevices = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        loboPanel.addView(lanDevices, LinearLayout.LayoutParams(-1, -2))
        val rememberedRows = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        loboPanel.addView(rememberedRows, LinearLayout.LayoutParams(-1, -2))
        val manualAddress = button("ENTER ADDRESS MANUALLY", parent = loboPanel) {}
        val endpointLabel = label("Provider address", 15f, MUTED, form)
        val endpoint = field("Provider base URL ending in /v1", 2048, parent = form)
        endpoint.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        val authLabel = label("Verify device identity · LOBO AUTH code", 15f, MUTED, form)
        val auth = field("XXXX-XXXX", 9, secret = true, parent = form)
        val verifyAgain = button("VERIFY DEVICE AGAIN", parent = form) {}
        val forgetDevice = button("FORGET REMEMBERED DEVICE", parent = form) {}
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
        form.addView(authorization, form.indexOfChild(authLabel), LinearLayout.LayoutParams(-1, -2).apply {
            setMargins(0, dp(8), 0, dp(4))
        })
        val authorizationTitle = label("Provider changes are locked", 16f, Color.WHITE, authorization)
        label("Unlock once to manage this server's summarization settings.", 14f, MUTED, authorization)
        val unlock = button("UNLOCK CHANGES", primary = true, parent = authorization) {}
        val codePanel = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        authorization.addView(codePanel, LinearLayout.LayoutParams(-1, -2))
        var authorizationOpen = openAuthorization
        label("Generate a one-time administrator code on Transcriber:", 14f, MUTED, codePanel)
        label("docker compose exec transcriber python -m transcriber summary-admin", 14f, ACCENT, codePanel)
        if (connection.address.startsWith("http://")) {
            label("HTTP connection: use a trusted private network. New provider API keys require HTTPS.", 13f, MUTED, codePanel)
        }
        val adminCode = field("Administrator code (XXXX-XXXX)", 9, secret = true, parent = codePanel)
        val authorizeButton = button("UNLOCK", true, codePanel) {}
        val retryOpen = button("RETRY CONNECTION", parent = authorization) {
            if (state.canOpen) request(actions.open(), "Connecting to Transcriber…") { showConfiguration() }
        }
        val policyButton = button("REQUIRE ADMINISTRATOR CODE", parent = form) {
            if (state.canSetPolicy) request(actions.policy(!state.adminRequired), "Saving security policy…") { load() }
        }
        val advancedButton = button("ADVANCED SECURITY & CONNECTION SETTINGS", parent = form) {
            advanced = !advanced
            if (!advanced) {
                authorizationOpen = false
                hideKeyboard()
                adminCode.text.clear()
            }
            refreshControls()
        }
        val candidateCard = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = surface(BACKGROUND, BORDER)
            setPadding(dp(12), dp(6), dp(12), dp(8))
        }
        form.addView(candidateCard, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        label("PROPOSED REPLACEMENT · NOT SAVED", 13f, ACCENT, candidateCard)
        val candidateTitle = label("", 19f, Color.WHITE, candidateCard)
        val candidateDetail = label("", 14f, MUTED, candidateCard)
        val discoverButton = button("DISCOVER MODELS", parent = form) {}
        val modelPanel = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        form.addView(modelPanel, LinearLayout.LayoutParams(-1, -2))
        val placeholder = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        form.addView(placeholder, LinearLayout.LayoutParams(-1, -2))
        val placeholderMessage = label("Unlock changes to discover models.", 14f, MUTED, placeholder)
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
        val rememberedButtons = linkedMapOf<String, Button>()
        var scanningLan = false
        var failedLan = false
        val authorizationLabel = TextView(context).apply {
            textSize = 14f
            setTextColor(SUCCESS)
            visibility = View.GONE
        }
        form.addView(authorizationLabel, form.indexOfChild(discoverButton), LinearLayout.LayoutParams(-1, -2))

        fun clearModelPanel() {
            (consent.parent as? ViewGroup)?.removeView(consent)
            (save.parent as? ViewGroup)?.removeView(save)
            modelPanel.removeAllViews()
            testButton = null
            modelPanel.visibility = View.GONE
            placeholder.visibility = View.VISIBLE
            refreshControls()
        }

        fun renderChoices() {
            val usingCurrent = state.choice == SummaryProviderChoice.REUSE
            currentChoice?.let {
                it.isSelected = usingCurrent
                it.setTextColor(if (usingCurrent) ACCENT else Color.WHITE)
                it.background = surface(if (usingCurrent) 0xff342f1c.toInt() else FIELD,
                    if (usingCurrent) ACCENT else BORDER, if (usingCurrent) 2 else 1)
            }
            choices.forEachIndexed { index, choice ->
                val chosen = state.choice == kinds[index]
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
                    "Selected: ${picked.name} · " + (if (state.usesStoredLoboTrust) "Stored trust" else "Identity not verified")
                    else "Selected: ${picked.name} · Last seen, not currently advertised"
                scanningLan -> "Finding LOBO devices…"
                failedLan -> "Discovery unavailable"
                lanSelection.devices.isEmpty() -> "No LOBO devices found. Check the LAN or enter the address manually."
                else -> "${lanSelection.devices.size} LOBO device(s) found · Identity checked on connection"
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
                val chosen = picked?.address == address || state.draftEndpoint == device.endpoint
                val row = lanButtons.getOrPut(address) {
                    button("", parent = lanDevices) {
                        if (formCurrent() && state.editable && state.choice == SummaryProviderChoice.LOBO &&
                            (lanSelection.selected?.address != address || manualLobo)) {
                            val chosenDevice = lanSelection.select(address)
                            if (chosenDevice != null) {
                                manualLobo = false
                                suppressChanges = true
                                endpoint.setText(chosenDevice.endpoint)
                                auth.text.clear()
                                suppressChanges = false
                                if (workflow.addressEdited(chosenDevice.endpoint)) clearModelPanel()
                                endpoint.visibility = View.GONE
                                endpointLabel.visibility = View.GONE
                                manualAddress.text = "ENTER ADDRESS MANUALLY"
                                renderLanDevices()
                                if (state.usesStoredLoboTrust || state.canUseLoboTofu) discoverDraft?.invoke()
                            }
                        }
                    }.apply {
                        isAllCaps = false
                        backgroundTintList = null
                    }
                }
                val stored = state.authorization?.let { it.remembersLobo(device.endpoint) || it.matchesTrustedLobo(device.endpoint) } == true
                row.text = "${device.name}  ·  ${device.address}" +
                    (if (stored) "  ·  REMEMBERED" else "") + (if (chosen) "  ·  SELECTED" else "")
                row.isSelected = chosen
                row.isEnabled = state.editable
                row.setTextColor(if (chosen) ACCENT else Color.WHITE)
                row.background = surface(if (chosen) 0xff342f1c.toInt() else FIELD,
                    if (chosen) ACCENT else BORDER, if (chosen) 2 else 1)
            }
            val advertisedEndpoints = visible.map { it.endpoint }.toSet()
            val remembered = state.authorization?.takeUnless { it.storageError }?.trustedLoboEndpoints.orEmpty()
                .filterNot { it in advertisedEndpoints }
            for (value in rememberedButtons.keys.toList()) {
                if (value !in remembered) rememberedButtons.remove(value)?.let { rememberedRows.removeView(it) }
            }
            remembered.forEach { value ->
                val chosen = state.draftEndpoint == value
                val row = rememberedButtons.getOrPut(value) {
                    button("", parent = rememberedRows) {
                        if (formCurrent() && state.editable && state.choice == SummaryProviderChoice.LOBO) {
                            lanSelection.clearSelection()
                            manualLobo = true
                            suppressChanges = true
                            endpoint.setText(value)
                            auth.text.clear()
                            suppressChanges = false
                            if (workflow.addressEdited(value)) clearModelPanel()
                            endpoint.visibility = View.VISIBLE
                            endpointLabel.visibility = View.VISIBLE
                            manualAddress.text = "CHOOSE DISCOVERED DEVICE"
                            renderLanDevices()
                            if (state.usesStoredLoboTrust || state.canUseLoboTofu) discoverDraft?.invoke()
                        }
                    }.apply { isAllCaps = false }
                }
                row.text = value.removePrefix("https://").removeSuffix("/v1") +
                    "  ·  REMEMBERED · NOT ADVERTISED" + (if (chosen) "  ·  SELECTED" else "")
                row.isSelected = chosen
                row.isEnabled = state.editable
                row.setTextColor(if (chosen) ACCENT else Color.WHITE)
                row.background = surface(if (chosen) 0xff342f1c.toInt() else FIELD,
                    if (chosen) ACCENT else BORDER, if (chosen) 2 else 1)
            }
        }

        fun scanLan() {
            if (!formCurrent() || !state.editable || state.choice != SummaryProviderChoice.LOBO) return
            loboDiscovery.start { devices, scanning, failed ->
                if (formCurrent() && state.choice == SummaryProviderChoice.LOBO) {
                    lanSelection.update(devices)
                    scanningLan = scanning
                    failedLan = failed
                    renderLanDevices()
                }
            }
        }

        fun configure() {
            val choice = state.choice
            val reuse = choice == SummaryProviderChoice.REUSE
            val lobo = choice == SummaryProviderChoice.LOBO
            suppressChanges = true
            loboDiscovery.stop()
            lanSelection.reset()
            lanButtons.clear()
            lanDevices.removeAllViews()
            rememberedButtons.clear()
            rememberedRows.removeAllViews()
            scanningLan = false
            failedLan = false
            manualLobo = lobo && state.draftEndpoint != null
            clearModelPanel()
            auth.text.clear()
            key.text.clear()
            endpoint.isEnabled = !reuse
            endpoint.setText(state.draftEndpoint.orEmpty())
            endpoint.hint = when (choice) {
                SummaryProviderChoice.OLLAMA -> "http://ollama-host:11434/v1"
                SummaryProviderChoice.LOBO -> "https://192.168.1.200:7869/v1"
                else -> "https://server.example/v1"
            }
            val showAuth = lobo
            loboPanel.visibility = if (showAuth) View.VISIBLE else View.GONE
            endpointLabel.visibility = if (showAuth && !manualLobo) View.GONE else View.VISIBLE
            endpoint.visibility = endpointLabel.visibility
            manualAddress.text = if (manualLobo) "CHOOSE DISCOVERED DEVICE" else "ENTER ADDRESS MANUALLY"
            authLabel.visibility = if (showAuth) View.VISIBLE else View.GONE
            auth.visibility = authLabel.visibility
            val showKey = !reuse && !lobo && connection.address.startsWith("https://")
            keyLabel.visibility = if (showKey) View.VISIBLE else View.GONE
            key.visibility = keyLabel.visibility
            allowHttp.visibility = if (!reuse && !lobo) View.VISIBLE else View.GONE
            allowHttp.isChecked = if (state.automaticActivation && choice == SummaryProviderChoice.OLLAMA) true
                else (reuse || state.draftEndpoint == state.authorization?.baseUrl) && state.authorization?.allowHttp == true
            hint.text = when {
                reuse -> "Reuse the active endpoint, credentials and certificate trust."
                choice == SummaryProviderChoice.OLLAMA -> "Address must be reachable from Transcriber."
                lobo -> "Select a phone. On a trusted LAN you may accept its first certificate, or verify its identity using AUTH."
                else -> "Custom private CAs can be configured on the server and reused here."
            }
            discoverButton.text = if (reuse) "DISCOVER CURRENT MODELS" else "DISCOVER MODELS"
            renderChoices()
            suppressChanges = false
            if (showAuth) {
                renderLanDevices()
                scanLan()
            }
            refreshControls()
        }

        fun chooseProvider(choice: SummaryProviderChoice) {
            if (formCurrent() && workflow.choose(choice)) {
                configure()
                if (choice == SummaryProviderChoice.REUSE) discoverDraft?.invoke()
            }
        }

        fun showDiscovered(value: SummaryProviderDiscovery) {
            clearModelPanel()
            modelPanel.visibility = View.VISIBLE
            placeholder.visibility = View.GONE
            label("Model", 15f, MUTED, modelPanel)
            val result = TextView(context).apply {
                text = "Not tested"
                textSize = 15f
                setTextColor(MUTED)
                setPadding(0, dp(4), 0, dp(4))
            }
            val discoveryForPanel = value
            fun changed(value: String?) {
                if (!formCurrent() || state.discovery !== discoveryForPanel) return
                if (workflow.selectModel(value)) {
                    result.text = "Not tested"
                    result.setTextColor(MUTED)
                    refreshControls()
                    if ((state.automaticActivation || state.choice == SummaryProviderChoice.LOBO) && discoveryForPanel.models.isNotEmpty() && state.model != null) {
                        testButton?.performClick()
                    }
                }
            }
            if (value.models.isEmpty()) {
                val manual = field("Model identifier", 160, parent = modelPanel)
                watch(manual) { changed(manual.text.toString().trim()) }
            } else {
                val chooseModel = state.automaticActivation && state.model == null
                val options = if (chooseModel) listOf("Choose a model") + value.models else value.models
                val models = spinner(options, modelPanel)
                val index = value.models.indexOf(state.model).let { if (chooseModel) 0 else it.coerceAtLeast(0) }
                models.setSelection(index)
                models.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                    override fun onNothingSelected(parent: AdapterView<*>?) = changed(null)
                    override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                        changed(value.models.getOrNull(if (chooseModel) position - 1 else position))
                    }
                }
            }
            testButton = button(if (state.automaticActivation) "ACTIVATE MODEL" else "TEST INFERENCE", parent = modelPanel) {
                if (formCurrent() && state.discovery === discoveryForPanel && state.canTest) {
                    request(actions.test(), "Running inference…", onStart = {
                        result.text = "Testing…"
                        result.setTextColor(MUTED)
                    }, onFailure = {
                        result.text = "Test failed. Retry or choose another model."
                        result.setTextColor(MUTED)
                    }) {
                        val tested = state.tested
                        if (tested != null) {
                            result.text = "Test passed · " + String.format(Locale.US, "%.2f s", tested.elapsedMs / 1000.0)
                            result.setTextColor(SUCCESS)
                            if (state.automaticActivation && state.canSave) {
                                request(actions.save(), "Activating provider…") { finish() }
                            } else status.text = "Ready to save"
                        } else {
                            result.text = "Test failed. Retry or choose another model."
                            result.setTextColor(MUTED)
                        }
                    }
                }
            }
            modelPanel.addView(result)
            if (!state.automaticActivation) {
                modelPanel.addView(consent)
                modelPanel.addView(save, LinearLayout.LayoutParams(-1, dp(48)).apply {
                    setMargins(0, dp(6), 0, dp(2))
                })
            }
            refreshControls()
            if ((state.automaticActivation || state.choice == SummaryProviderChoice.LOBO) && state.model != null) testButton?.performClick()
        }

        consent.setOnCheckedChangeListener { _, checked ->
            if (formCurrent() && workflow.setConsent(checked)) refreshControls()
        }
        save.setOnClickListener {
            if (formCurrent() && state.canSave) request(actions.save(), "Saving provider…") { finish() }
        }
        names.forEachIndexed { index, name ->
            val choice = Button(context).apply {
                text = name
                isAllCaps = false
                textSize = 16f
                setOnClickListener { chooseProvider(kinds[index]) }
            }
            choices.add(choice)
            providerRow.addView(choice, LinearLayout.LayoutParams(0, -1, 1f).apply {
                setMargins(if (index == 0) 0 else dp(4), 0, if (index == names.lastIndex) 0 else dp(4), 0)
            })
        }
        currentChoice = button("USE CURRENT PROVIDER", parent = form, index = 2) {
            chooseProvider(SummaryProviderChoice.REUSE)
        }
        manualAddress.setOnClickListener {
            if (!formCurrent() || !state.editable || state.choice != SummaryProviderChoice.LOBO) return@setOnClickListener
            manualLobo = !manualLobo
            lanSelection.clearSelection()
            suppressChanges = true
            endpoint.text.clear()
            auth.text.clear()
            suppressChanges = false
            if (workflow.addressEdited("")) clearModelPanel()
            endpoint.visibility = if (manualLobo) View.VISIBLE else View.GONE
            endpointLabel.visibility = endpoint.visibility
            manualAddress.text = if (manualLobo) "CHOOSE DISCOVERED DEVICE" else "ENTER ADDRESS MANUALLY"
            renderLanDevices()
        }
        unlock.setOnClickListener {
            if (formCurrent() && state.canAuthorize) {
                authorizationOpen = !authorizationOpen
                if (!authorizationOpen) {
                    hideKeyboard()
                    adminCode.text.clear()
                }
                refreshControls()
            }
        }
        watch(adminCode) { if (formCurrent()) refreshControls() }
        verifyAgain.setOnClickListener {
            if (formCurrent() && workflow.setVerifyLoboAgain(!state.verifyLoboAgain)) {
                suppressChanges = true
                auth.text.clear()
                suppressChanges = false
                clearModelPanel()
                renderLanDevices()
                if (!state.verifyLoboAgain && (state.usesStoredLoboTrust || state.canUseLoboTofu)) discoverDraft?.invoke()
            }
        }
        watch(endpoint) {
            if (formCurrent() && !suppressChanges && workflow.addressEdited(endpoint.text.toString())) {
                if (state.choice == SummaryProviderChoice.LOBO) {
                    suppressChanges = true
                    auth.text.clear()
                    suppressChanges = false
                    renderLanDevices()
                }
                clearModelPanel()
            }
        }
        fun credentialsEdited() {
            if (formCurrent() && !suppressChanges && workflow.credentialsOrTrustEdited()) clearModelPanel()
        }
        listOf(auth, key).forEach { edit -> watch(edit) { credentialsEdited() } }
        allowHttp.setOnCheckedChangeListener { _, _ -> credentialsEdited() }
        fun connectDraft(tofu: Boolean) {
            if (!formCurrent() || !state.canDiscover || (tofu && !state.canUseLoboTofu)) return
            request(actions.discover(endpoint.text.toString(), allowHttp.isChecked, key.text.toString(),
                auth.text.toString(), tofu = tofu),
                if (state.choice == SummaryProviderChoice.LOBO) "Connecting to LOBO…" else "Discovering models…",
                onStart = { clearModelPanel() }, onFailure = {
                    suppressChanges = true
                    auth.text.clear()
                    suppressChanges = false
                }) {
                suppressChanges = true
                auth.text.clear()
                suppressChanges = false
                state.discovery?.let { showDiscovered(it) }
            }
        }

        discoverDraft = {
            if (formCurrent() && state.canDiscover) {
                if (state.canUseLoboTofu) {
                    if (state.automaticActivation && !advanced) {
                        connectDraft(true)
                    } else {
                    val selected = state.draftEndpoint
                    confirmChange("Trust this LOBO device?",
                        "Use first-use trust only on your trusted LAN. The first connection to $selected is not independently authenticated. " +
                            "Its certificate will be remembered after Save; future connections must match. For stronger identity verification, cancel and choose Verify with AUTH.",
                        "TRUST & CONNECT") {
                        if (formCurrent() && state.canUseLoboTofu && state.draftEndpoint == selected) connectDraft(true)
                    }
                    }
                } else if (state.choice == SummaryProviderChoice.LOBO && !state.usesStoredLoboTrust &&
                    state.discovery != null) {
                    workflow.credentialsOrTrustEdited()
                    clearModelPanel()
                } else if (!summaryProviderPresentation(state).showLoboVerification ||
                    SummaryProviderManagement.normalizeLoboAuth(auth.text.toString()) != null) {
                    connectDraft(false)
                }
            }
        }
        discoverButton.setOnClickListener { discoverDraft?.invoke() }
        forgetDevice.setOnClickListener {
            val selected = state.draftEndpoint
            if (formCurrent() && state.canForgetLobo && selected != null) {
                confirmChange("Forget remembered device?", "Remove stored certificate trust for $selected? You will need to trust or verify the device again.", "FORGET") {
                    if (formCurrent() && state.canForgetLobo && state.draftEndpoint == selected) {
                        request(actions.forgetLobo(), "Removing stored certificate trust…", onStart = { clearModelPanel() }) {
                            if (state.screen == SummaryProviderScreen.RELOAD_REQUIRED) finish()
                            else {
                                suppressChanges = true
                                auth.text.clear()
                                suppressChanges = false
                                status.text = "Device forgotten · Verify identity to use it again"
                                renderLanDevices()
                                clearModelPanel()
                            }
                        }
                    }
                }
            }
        }
        val disableButton = button("DISABLE SUMMARIZATION") {
            if (formCurrent() && state.canDisable) {
                confirmChange("Disable summarization?", "Summary and recap generation will be disabled for all connected bikes. Transcription and playback remain available.", "DISABLE") {
                    if (formCurrent() && state.canDisable) request(actions.disable(), "Disabling…") { finish() }
                }
            }
        }
        val cancelButton = button("CLOSE CONFIGURATION SESSION") {
            if (formCurrent() && state.canCancel) request(actions.cancel(), "Closing administrator session…") { load() }
        }
        renderConfiguration = {
            val snapshot = state
            val presentation = summaryProviderPresentation(snapshot)
            activeTitle.text = presentation.activeTitle
            activeDetail.text = presentation.activeDetail
            candidateTitle.text = presentation.candidateTitle
            candidateDetail.text = presentation.candidateDetail
            candidateDetail.setTextColor(if (snapshot.tested != null) SUCCESS else MUTED)
            val needsLoboAuth = presentation.showLoboVerification
            if (presentation.reuseTrust && auth.text.isNotEmpty()) {
                val previous = suppressChanges
                suppressChanges = true
                auth.text.clear()
                suppressChanges = previous
            }
            forgetDevice.visibility = if ((!snapshot.automaticActivation || advanced) && snapshot.choice == SummaryProviderChoice.LOBO &&
                snapshot.authorization?.remembersLobo(snapshot.draftEndpoint) == true &&
                snapshot.authorization?.matchesTrustedLobo(snapshot.draftEndpoint) != true) View.VISIBLE else View.GONE
            forgetDevice.isEnabled = snapshot.canForgetLobo
            verifyAgain.visibility = if ((!snapshot.automaticActivation || advanced) && snapshot.authorized && snapshot.choice == SummaryProviderChoice.LOBO &&
                snapshot.addressEntered && (snapshot.hasStoredLoboTrust || snapshot.canUseLoboTofu || snapshot.verifyLoboAgain))
                View.VISIBLE else View.GONE
            verifyAgain.isEnabled = snapshot.editable
            verifyAgain.text = when {
                snapshot.verifyLoboAgain && snapshot.hasStoredLoboTrust -> "USE REMEMBERED CERTIFICATE"
                snapshot.verifyLoboAgain -> "USE FIRST-USE TRUST"
                snapshot.hasStoredLoboTrust -> "VERIFY DEVICE AGAIN"
                else -> "VERIFY WITH AUTH"
            }
            authLabel.visibility = if (needsLoboAuth) View.VISIBLE else View.GONE
            auth.visibility = authLabel.visibility
            val showKey = snapshot.choice != SummaryProviderChoice.REUSE && snapshot.choice != SummaryProviderChoice.LOBO &&
                connection.address.startsWith("https://") && (!snapshot.automaticActivation || advanced)
            keyLabel.visibility = if (showKey) View.VISIBLE else View.GONE
            key.visibility = keyLabel.visibility
            allowHttp.visibility = if (snapshot.choice != SummaryProviderChoice.REUSE && snapshot.choice != SummaryProviderChoice.LOBO &&
                (!snapshot.automaticActivation || advanced)) View.VISIBLE else View.GONE
            advancedButton.visibility = if (snapshot.automaticActivation) View.VISIBLE else View.GONE
            advancedButton.text = if (advanced) "HIDE ADVANCED SETTINGS" else "ADVANCED SECURITY & CONNECTION SETTINGS"
            policyButton.visibility = if (snapshot.automaticActivation && advanced) View.VISIBLE else View.GONE
            policyButton.text = if (snapshot.adminRequired) "REMOVE ADMINISTRATOR CODE REQUIREMENT" else "REQUIRE ADMINISTRATOR CODE"
            policyButton.isEnabled = snapshot.canSetPolicy
            authorizationTitle.text = if (snapshot.adminRequired) "Provider changes are locked" else "Administrator authorization (optional)"
            retryOpen.visibility = if (snapshot.canOpen) View.VISIBLE else View.GONE
            if (snapshot.choice == SummaryProviderChoice.LOBO) {
                hint.text = when {
                    !snapshot.addressEntered -> "Select a phone or enter its address."
                    !snapshot.authorized -> "Unlock changes to check whether the phone is remembered."
                    snapshot.discovery != null -> "HTTPS connection established. Save after a successful inference test."
                    presentation.reuseTrust -> "Stored certificate trust · HTTPS is still verified."
                    snapshot.canUseLoboTofu -> "First-use trust is available on a trusted LAN. AUTH verification is optional."
                    else -> "Use the AUTH code shown on the phone to verify its identity. This is not an inference password."
                }
            }
            endpoint.isEnabled = snapshot.editable && snapshot.choice != SummaryProviderChoice.REUSE
            discoverButton.text = presentation.discoveryLabel
            discoverButton.visibility = if (snapshot.authorized && !(snapshot.choice == SummaryProviderChoice.LOBO &&
                snapshot.discovery != null)) View.VISIBLE else View.GONE
            val discoveryReady = snapshot.canDiscover && (!needsLoboAuth ||
                SummaryProviderManagement.normalizeLoboAuth(auth.text.toString()) != null)
            discoverButton.isEnabled = discoveryReady
            discoverButton.alpha = if (discoveryReady) 1f else 0.4f
            currentChoice?.isEnabled = snapshot.canReuse
            codePanel.visibility = if (authorizationOpen) View.VISIBLE else View.GONE
            unlock.text = if (authorizationOpen) "HIDE CODE ENTRY" else "UNLOCK CHANGES"
            unlock.isEnabled = snapshot.canAuthorize
            authorizeButton.isEnabled = snapshot.canAuthorize && runCatching {
                TranscriberConnection.normalizeCode(adminCode.text.toString())
            }.isSuccess
            placeholderMessage.text = when {
                !snapshot.authorized -> "Unlock changes to discover models."
                needsLoboAuth -> "Verify the device to discover its models."
                else -> "Discover models to choose one."
            }
            testButton?.isEnabled = snapshot.canTest && snapshot.model != null
            testButton?.visibility = if (snapshot.choice == SummaryProviderChoice.LOBO &&
                (snapshot.tested != null || snapshot.pending?.operation == SummaryProviderOperation.TEST)) View.GONE else View.VISIBLE
            consent.isEnabled = snapshot.canTest
            consent.isChecked = snapshot.consent
            save.isEnabled = snapshot.canSave
            save.alpha = if (snapshot.canSave) 1f else 0.4f
            authorization.visibility = if ((!snapshot.authorized && (snapshot.adminRequired || snapshot.canOpen)) ||
                (advanced && snapshot.canAuthorize)) View.VISIBLE else View.GONE
            authorizationLabel.visibility = if (snapshot.authorized) View.VISIBLE else View.GONE
            authorizationLabel.text = if (snapshot.authorization?.storageError == true)
                "Authorized · Saved settings could not be loaded. Save a provider to recover."
                else if (snapshot.authorization?.administrator == true) "Administrator authorized" else "Paired device · ready"
            currentChoice?.visibility = if (snapshot.authorization?.configured == true) View.VISIBLE else View.GONE
            disableButton.visibility = if (snapshot.authorization?.configured == true) View.VISIBLE else View.GONE
            disableButton.isEnabled = snapshot.canDisable
            cancelButton.visibility = if (snapshot.authorized && (!snapshot.automaticActivation || advanced)) View.VISIBLE else View.GONE
            cancelButton.isEnabled = snapshot.canCancel
        }
        authorizeButton.setOnClickListener {
            if (!formCurrent() || !state.canAuthorize || !authorizationOpen) return@setOnClickListener
            val code = runCatching { TranscriberConnection.normalizeCode(adminCode.text.toString()) }.getOrNull() ?: return@setOnClickListener
            val previousChoice = state.choice
            request(actions.authorize(code), "Unlocking changes…", onFailure = { adminCode.text.clear() }) {
                adminCode.text.clear()
                authorizationOpen = false
                status.text = "Changes unlocked"
                if (state.choice != previousChoice) configure()
                refreshControls()
                if (state.choice == SummaryProviderChoice.LOBO) renderLanDevices()
                if (!state.automaticActivation && (state.usesStoredLoboTrust || state.canUseLoboTofu || state.choice == SummaryProviderChoice.REUSE)) discoverDraft?.invoke()
            }
        }
        configure()
    }

    private fun watch(edit: EditText, changed: () -> Unit) {
        edit.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = changed()
            override fun afterTextChanged(s: Editable?) = Unit
        })
    }

    private var renderConfiguration: (() -> Unit)? = null
    private fun refreshControls() { renderConfiguration?.invoke() }

    private fun finish() {
        resetRows()
        if (state.screen == SummaryProviderScreen.RELOAD_REQUIRED) {
            status.text = "Change could not be confirmed. Reload to verify provider settings and remembered devices."
            button("RELOAD") { load() }
            return
        }
        status.text = state.activeModel?.let { "Active · $it" } ?: "Summarization disabled"
        val presentation = summaryProviderPresentation(state)
        label("CURRENTLY SAVED", 13f, MUTED)
        label(presentation.activeTitle, 22f, Color.WHITE)
        label(presentation.activeDetail, 14f, MUTED)
        label("Changes are active on Transcriber. Reopen an audiobook to refresh its provider information.", 16f, SUCCESS)
        if (!embedded) button("DONE", true) { dialog.dismiss() }
        button("MANAGE AGAIN", primary = embedded) { load() }
    }

    private fun <T> request(
        action: SummaryProviderAction<T>,
        message: String,
        onStart: () -> Unit = {},
        onFailure: () -> Unit = {},
        success: (T) -> Unit,
    ) {
        val ticket = actions.begin(action) ?: return
        status.text = message
        onStart()
        hideKeyboard()
        enableRows(false)
        refreshControls()
        pendingWork = worker.submit {
            val result = runCatching(action.execute)
            main.post {
                if (state.pending !== ticket) {
                    actions.discardClosedCompletion()
                    return@post
                }
                pendingWork = null
                result.fold({ value ->
                    if (actions.complete(action, ticket, value)) {
                        enableRows(true)
                        success(value)
                        refreshControls()
                    }
                }, { error ->
                    if (actions.fail(ticket, error)) {
                        enableRows(true)
                        if (state.screen == SummaryProviderScreen.RELOAD_REQUIRED) {
                            finish()
                        } else if (actions.authorizationLost(error) || ticket.operation == SummaryProviderOperation.CANCEL) {
                            if (state.screen == SummaryProviderScreen.CONFIGURATION) showConfiguration(openAuthorization = state.adminRequired)
                        } else onFailure()
                        if (state.screen != SummaryProviderScreen.RELOAD_REQUIRED) status.text = failureMessage(error)
                        refreshControls()
                    }
                })
            }
        }
    }

    private fun failureMessage(error: Throwable): String = when (error) {
        is SummaryManagementFailure -> when (error.code) {
            "lobo_identity_verification_required" -> "This endpoint is not remembered by Transcriber. Verify with AUTH or update Transcriber for first-use trust."
            "lobo_already_remembered" -> "This device is already remembered. Reload settings; use its stored trust or verify with AUTH."
            "lobo_trust_storage_error" -> "Remembered trust could not be read. Use manual AUTH to recover."
            "lobo_trust_registry_full_or_invalid" -> "Remembered device storage is full or invalid. Forget an inactive device before adding another."
            "lobo_trust_active" -> "Switch away from this active provider before forgetting it."
            "lobo_trust_not_found" -> "The device is no longer remembered. Reload settings."
            "lobo_auth_mismatch" -> "LOBO AUTH code does not match this phone."
            "lobo_certificate_unavailable" -> "Unable to retrieve LOBO's certificate. Check its address."
            "lobo_private_ipv4_required" -> "LOBO requires a private IPv4 HTTPS address on port 7869 ending in /v1."
            "invalid_summary_admin_code" -> "Invalid administrator code. Try again."
            "summary_admin_unavailable", "unauthorized" -> "Administrator session expired or rejected. Generate a new code."
            "summary_busy" -> "Transcriber is busy with another summary. Retry."
            "provider_authentication" -> "Provider rejected its credentials."
            "provider_timeout" -> "Provider inference timed out."
            "provider_unavailable" -> if (state.usesStoredLoboTrust)
                "Cannot reach or verify the remembered device. If its certificate changed, choose Verify device again."
                else "Cannot reach or verify the provider. Check address and TLS trust."
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
        val focused = rows.findFocus() as? EditText ?: return
        focused.windowToken?.let { inputMethod()?.hideSoftInputFromWindow(it, 0) }
        focused.clearFocus()
    }

    private fun showKeyboard(editor: EditText) {
        if (closed || !editor.isEnabled || !editor.isShown) return
        if (!embedded) dialog.window?.clearFlags(WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM or
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
        if (!editor.requestFocus()) return
        editor.post {
            if (!closed && editor.isEnabled && editor.isShown && editor.hasFocus() && editor.hasWindowFocus()) {
                inputMethod()?.showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT)
            }
        }
    }

    private fun clearSecrets() { secretFields.forEach { it.text.clear() } }

    private fun confirmChange(title: String, message: String, actionLabel: String, action: () -> Unit) {
        confirmation?.dismiss()
        val prompt = AlertDialog.Builder(context).setTitle(title).setMessage(message)
            .setNegativeButton("CANCEL", null).setPositiveButton(actionLabel) { _, _ -> action() }.create()
        confirmation = prompt
        prompt.setOnDismissListener { if (confirmation === prompt) confirmation = null }
        prompt.show()
    }

    private fun resetRows() {
        formGeneration++
        confirmation?.dismiss()
        confirmation = null
        loboDiscovery.stop()
        renderConfiguration = null
        clearSecrets()
        secretFields.clear()
        rows.removeAllViews()
        if (!embedded) scroll.scrollTo(0, 0)
    }

    private fun enableRows(enabled: Boolean) = setDialogTreeEnabled(rows, enabled)

    private fun label(value: String, size: Float = 16f, color: Int = MUTED,
                      parent: LinearLayout = rows): TextView =
        views.label(parent, value, size, color)

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
                       index: Int = -1, action: () -> Unit): Button {
        val generation = formGeneration
        return views.button(parent, value, primary = primary, index = index) {
            if (!closed && state.idle && generation == formGeneration) action()
        }
    }

    private fun dp(value: Int): Int = views.dp(value)

    private fun surface(fill: Int, stroke: Int, width: Int = 1) = views.surface(fill, stroke, width)

    private companion object {
        val ACCENT = NativeDialogStyle.SUMMARY_PROVIDER.accent
        val BACKGROUND = 0xff101720.toInt()
        val CARD = 0xff1a2330.toInt()
        val FIELD = NativeDialogStyle.SUMMARY_PROVIDER.buttonFill
        val BORDER = NativeDialogStyle.SUMMARY_PROVIDER.buttonBorder
        val MUTED = 0xffc1cbd7.toInt()
        val SUCCESS = 0xff58d5a5.toInt()
    }
}
