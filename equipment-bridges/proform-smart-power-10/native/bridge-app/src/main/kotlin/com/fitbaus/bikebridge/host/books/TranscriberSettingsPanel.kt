package com.fitbaus.bikebridge.host.books

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
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import com.fitbaus.bikebridge.host.ui.NativeDialogStyle
import com.fitbaus.bikebridge.host.ui.NativeDialogViews
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal class TranscriberSettingsPanel(context: Context) : LinearLayout(context) {
    private enum class Tab { Models, Summarization }

    private val views = NativeDialogViews(context, NativeDialogStyle.TRANSCRIPTION_MODELS)
    private val store = TranscriberConnectionStore(context)
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val protocol = Spinner(context)
    private val host = EditText(context)
    private val port = EditText(context)
    private val code = EditText(context)
    private val status = TextView(context)
    private val connect = Button(context)
    private val disconnect = Button(context)
    private val modelsTab = Button(context)
    private val summaryTab = Button(context)
    private val connectionTitle = TextView(context)
    private val connectionToggle = Button(context)
    private val connectionForm = LinearLayout(context)
    private val content = LinearLayout(context)
    private var summaryPanel: SummaryProviderDialog? = null
    private var modelsPanel: TranscriberManagementDialog? = null
    private var selectedTab = Tab.Models
    private var expanded = true
    private var busy = false
    private var saved: TranscriberConnection? = null
    private var generation = 0L
    private var pending: Future<*>? = null
    private var active = false

    init {
        orientation = VERTICAL
        setPadding(0, dp(8), 0, 0)
        setBackgroundColor(BACKGROUND)
        views.label(this, "Transcriber", 24f, Color.WHITE, true)
        views.label(this, "Audiobook read-along and optional AI summaries.", 15f, MUTED)
        val connectionCard = LinearLayout(context).apply {
            orientation = VERTICAL
            background = views.surface(CARD, BORDER)
            setPadding(dp(12), dp(8), dp(12), dp(8))
        }
        addView(connectionCard, LayoutParams(-1, -2).apply { bottomMargin = dp(10) })
        val header = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val description = LinearLayout(context).apply { orientation = VERTICAL }
        connectionTitle.apply {
            text = "Transcriber server"
            textSize = 17f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
        }
        status.textSize = 14f
        status.setTextColor(MUTED)
        description.addView(connectionTitle, LayoutParams(-1, -2))
        description.addView(status, LayoutParams(-1, -2))
        header.addView(description, LayoutParams(0, -2, 1f))
        configureButton(connectionToggle, "Connection settings") { setExpanded(!expanded) }
        header.addView(connectionToggle, LayoutParams(-2, dp(48)).apply { leftMargin = dp(8) })
        connectionCard.addView(header)
        connectionForm.orientation = VERTICAL
        connectionForm.setPadding(0, dp(8), 0, 0)
        connectionCard.addView(connectionForm, LayoutParams(-1, -2))
        views.label(connectionForm, "Protocol, server address and port", 14f, MUTED)
        protocol.adapter = object : ArrayAdapter<String>(context, android.R.layout.simple_spinner_dropdown_item, listOf("https", "http")) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                super.getView(position, convertView, parent).also { (it as TextView).setTextColor(Color.WHITE) }
        }
        protocol.backgroundTintList = ColorStateList.valueOf(MUTED)
        styleField(host)
        styleField(port)
        styleField(code)
        host.hint = "Host or IP address"
        host.setSingleLine(true)
        host.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        host.filters = arrayOf(InputFilter.LengthFilter(253))
        port.hint = "Port"
        port.setSingleLine(true)
        port.inputType = InputType.TYPE_CLASS_NUMBER
        port.filters = arrayOf(InputFilter.LengthFilter(5))
        port.setText("8765")
        val row = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(protocol, LayoutParams(dp(104), dp(48)))
        row.addView(host, LayoutParams(0, dp(48), 1f).apply { leftMargin = dp(6); rightMargin = dp(6) })
        row.addView(port, LayoutParams(dp(94), dp(48)))
        connectionForm.addView(row, LayoutParams(-1, -2))
        views.label(connectionForm, "One-time Transcriber pairing code", 14f, MUTED)
        code.hint = "Pairing code (XXXX-XXXX)"
        code.setSingleLine(true)
        code.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        code.filters = arrayOf(InputFilter.AllCaps(), InputFilter.LengthFilter(9))
        code.addTextChangedListener(object : TextWatcher {
            private var formatting = false
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                if (formatting || s == null) return
                val raw = s.toString().replace("-", "")
                val formatted = if (raw.length > 4) raw.take(4) + "-" + raw.drop(4).take(4) else raw
                if (s.toString() == formatted) return
                formatting = true
                s.replace(0, s.length, formatted)
                formatting = false
            }
        })
        code.isSaveEnabled = false
        connectionForm.addView(code, LayoutParams(-1, dp(48)))
        views.label(connectionForm, "Generate a code on your Transcriber server:", 14f, MUTED)
        views.label(connectionForm, "docker compose exec transcriber python -m transcriber pair", 14f, ACCENT)
        val buttons = LinearLayout(context).apply { orientation = HORIZONTAL }
        configureButton(connect, "Connect", true) { connect() }
        configureButton(disconnect, "Disconnect") { disconnect() }
        buttons.addView(connect, LayoutParams(0, dp(48), 1f).apply { rightMargin = dp(4) })
        buttons.addView(disconnect, LayoutParams(0, dp(48), 1f).apply { leftMargin = dp(4) })
        connectionForm.addView(buttons, LayoutParams(-1, -2).apply { topMargin = dp(6) })
        val tabs = LinearLayout(context).apply {
            orientation = HORIZONTAL
            background = views.surface(BACKGROUND, BORDER)
            setPadding(dp(3), dp(3), dp(3), dp(3))
        }
        configureButton(modelsTab, "Transcription models") { selectTab(Tab.Models) }
        configureButton(summaryTab, "Summarization") { selectTab(Tab.Summarization) }
        tabs.addView(modelsTab, LayoutParams(0, dp(48), 1f).apply { rightMargin = dp(2) })
        tabs.addView(summaryTab, LayoutParams(0, dp(48), 1f).apply { leftMargin = dp(2) })
        addView(tabs, LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        content.orientation = VERTICAL
        addView(content, LayoutParams(-1, -2))
        setExpanded(true)
        renderTabs()
    }

    fun start() {
        if (active) return
        active = true
        status.setTextColor(Color.WHITE)
        status.text = "Loading connection…"
        request({ store.load() }, { connection ->
            saved = connection
            updateConnectionTitle()
            if (connection == null) {
                setStatus("Not connected")
                setExpanded(true)
                code.hint = "Pairing code (XXXX-XXXX)"
            } else {
                val uri = URI(connection.address)
                protocol.setSelection(if (uri.scheme == "http") 1 else 0)
                host.setText(uri.host)
                port.setText(if (uri.port == -1) "" else uri.port.toString())
                code.hint = "Paired (new code to replace)"
                setStatus("Paired · readiness not yet checked")
                setExpanded(false)
            }
            renderTabs()
            renderContent()
        }, "Unable to load saved connection. Disconnect to reset.")
    }

    fun stop() {
        active = false
        closeContent()
        hideKeyboard()
        generation++
        pending?.cancel(true)
        pending = null
        busy = false
        code.text.clear()
        saved = null
        updateConnectionTitle()
        renderTabs()
    }

    fun destroy() {
        stop()
        worker.shutdownNow()
    }

    private fun selectTab(tab: Tab) {
        if (!active || busy || selectedTab == tab) return
        selectedTab = tab
        renderTabs()
        renderContent()
    }

    private fun renderTabs() {
        fun apply(button: Button, selected: Boolean) {
            button.isSelected = selected
            button.isEnabled = active && !busy
            button.setTextColor(if (selected) Color.BLACK else Color.WHITE)
            button.background = views.surface(if (selected) ACCENT else BACKGROUND, if (selected) ACCENT else BACKGROUND)
            button.alpha = if (button.isEnabled) 1f else 0.5f
        }
        apply(modelsTab, selectedTab == Tab.Models)
        apply(summaryTab, selectedTab == Tab.Summarization)
        connect.text = if (saved == null) "Connect" else "Test / pair"
    }

    private fun closeContent() {
        summaryPanel?.close()
        summaryPanel = null
        modelsPanel?.close()
        modelsPanel = null
        content.removeAllViews()
    }

    private fun renderContent() {
        closeContent()
        if (!active || busy) return
        val connection = saved
        if (connection == null) {
            val empty = LinearLayout(context).apply {
                orientation = VERTICAL
                background = views.surface(CARD, BORDER)
                setPadding(dp(16), dp(12), dp(16), dp(12))
            }
            content.addView(empty, LayoutParams(-1, -2))
            views.label(empty, if (selectedTab == Tab.Models) "Transcription models" else "Summarization", 20f, Color.WHITE, true)
            views.label(empty, "Connect your Transcriber server above to get started. Audiobook playback works without it.", 15f, MUTED)
            return
        }
        when (selectedTab) {
            Tab.Models -> {
                views.label(content, "Transcription models", 21f, Color.WHITE, true)
                modelsPanel = TranscriberManagementDialog(context, connection).also { it.attach(content) }
            }
            Tab.Summarization -> {
                views.label(content, "Summarization provider", 21f, Color.WHITE, true)
                summaryPanel = SummaryProviderDialog(context, connection).also { it.attach(content) }
            }
        }
    }

    private fun setExpanded(value: Boolean) {
        if (!value) {
            hideKeyboard()
            code.text.clear()
        }
        expanded = value
        connectionForm.visibility = if (value) View.VISIBLE else View.GONE
        connectionToggle.text = if (value) "Hide settings" else "Connection settings"
    }

    private fun updateConnectionTitle() {
        connectionTitle.text = saved?.address ?: "Transcriber server"
    }

    private fun setStatus(message: String, ready: Boolean = false) {
        status.text = message
        status.setTextColor(if (ready) SUCCESS else MUTED)
    }

    private fun connect() {
        val address: String
        val pairingCode: String?
        val existing = saved
        try {
            address = BooksServer.address(protocol.selectedItem.toString(), host.text.toString(), port.text.toString(), false)
            val entered = code.text.toString()
            pairingCode = if (entered.isBlank() && existing?.address == address) null
                else TranscriberConnection.normalizeCode(entered)
        } catch (_: Exception) {
            status.setTextColor(Color.WHITE)
            status.text = "Enter a valid host, port and eight-character pairing code. HTTP requires a private IPv4 address."
            return
        }
        hideKeyboard()
        setStatus(if (pairingCode == null) "Testing connection…" else "Pairing…")
        request({
            val candidate = if (pairingCode == null) requireNotNull(existing)
                else TranscriberConnection.pair(address, pairingCode)
            val capabilities = candidate.test()
            check(!Thread.currentThread().isInterrupted)
            store.save(candidate)
            candidate to capabilities
        }, { (candidate, capabilities) ->
            saved = candidate
            updateConnectionTitle()
            code.text.clear()
            code.hint = "Paired (new code to replace)"
            setStatus(if (capabilities.ready) "Connected · ready" else "Connected · service not ready", capabilities.ready)
            setExpanded(false)
            renderTabs()
            renderContent()
        }, "Connection failed. Check the address and service; generate a fresh pairing code if needed.")
    }

    private fun disconnect() {
        hideKeyboard()
        request({ store.clear() }, {
            saved = null
            updateConnectionTitle()
            code.text.clear()
            code.hint = "Pairing code (XXXX-XXXX)"
            setStatus("Disconnected")
            setExpanded(true)
            renderTabs()
            renderContent()
        }, "Unable to clear saved connection.")
    }

    private fun setBusy(busy: Boolean) {
        this.busy = busy
        protocol.isEnabled = !busy
        host.isEnabled = !busy
        port.isEnabled = !busy
        code.isEnabled = !busy
        connect.isEnabled = !busy
        disconnect.isEnabled = !busy
        connectionToggle.isEnabled = !busy
        renderTabs()
    }

    private fun <T> request(action: () -> T, success: (T) -> Unit, failure: String) {
        if (!active || busy) return
        val id = ++generation
        closeContent()
        setBusy(true)
        pending = worker.submit {
            val result = runCatching(action)
            main.post {
                if (!active || generation != id) return@post
                pending = null
                setBusy(false)
                result.fold(success) {
                    setStatus(failure)
                    setExpanded(true)
                    renderContent()
                }
            }
        }
    }

    private fun configureButton(button: Button, value: String, primary: Boolean = false, action: () -> Unit) {
        button.text = value
        button.isAllCaps = false
        button.textSize = 15f
        button.setTextColor(if (primary) Color.BLACK else Color.WHITE)
        button.backgroundTintList = null
        button.background = views.surface(if (primary) ACCENT else FIELD, if (primary) ACCENT else BORDER)
        button.setPadding(dp(12), 0, dp(12), 0)
        button.setOnClickListener { action() }
    }

    private fun styleField(field: EditText) {
        field.setTextColor(Color.WHITE)
        field.setHintTextColor(MUTED)
        field.textSize = 16f
        field.setPadding(dp(12), 0, dp(12), 0)
        field.background = views.surface(FIELD, BORDER)
        field.isFocusable = true
        field.isFocusableInTouchMode = true
        field.setOnClickListener {
            if (field.isEnabled && field.requestFocus()) field.post {
                if (active && field.isShown && field.hasFocus() && field.hasWindowFocus()) {
                    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
                        ?.showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
                }
            }
        }
    }

    private fun hideKeyboard() {
        val field = connectionForm.findFocus() as? EditText ?: return
        field.windowToken?.let {
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(it, 0)
        }
        field.clearFocus()
    }

    private fun dp(value: Int) = views.dp(value)

    private companion object {
        val ACCENT = NativeDialogStyle.TRANSCRIPTION_MODELS.accent
        val BACKGROUND = 0xff101720.toInt()
        val CARD = 0xff1a2330.toInt()
        val FIELD = NativeDialogStyle.TRANSCRIPTION_MODELS.buttonFill
        val BORDER = NativeDialogStyle.TRANSCRIPTION_MODELS.buttonBorder
        val MUTED = 0xffc1cbd7.toInt()
        val SUCCESS = 0xff58d5a5.toInt()
    }
}
