package com.fitbaus.bikebridge.host.books

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal class TranscriberSettingsPanel(context: Context) : LinearLayout(context) {
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
    private val manageModels = Button(context)
    private var modelsDialog: AlertDialog? = null
    private var saved: TranscriberConnection? = null
    private var generation = 0L
    private var pending: Future<*>? = null
    private var active = false

    init {
        orientation = VERTICAL
        setPadding(0, dp(8), 0, 0)
        addView(TextView(context).apply {
            text = "Optional audiobook Read Along"
            textSize = 20f
            setTextColor(Color.WHITE)
        })
        addView(TextView(context).apply {
            text = "Connect your self-hosted FitBaus Transcriber. Audiobook playback does not require this service."
            textSize = 15f
            setTextColor(Color.LTGRAY)
        })
        protocol.adapter = ArrayAdapter(context, android.R.layout.simple_spinner_dropdown_item, listOf("https", "http"))
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
        row.addView(protocol, LayoutParams(dp(116), dp(56)))
        row.addView(host, LayoutParams(0, dp(56), 1f))
        row.addView(port, LayoutParams(dp(110), dp(56)))
        addView(row, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
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
        addView(code, LayoutParams(LayoutParams.MATCH_PARENT, dp(56)))
        status.textSize = 15f
        status.setTextColor(Color.WHITE)
        addView(status, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        connect.text = "CONNECT"
        connect.setOnClickListener { connect() }
        disconnect.text = "DISCONNECT"
        disconnect.setOnClickListener { disconnect() }
        val buttons = LinearLayout(context)
        buttons.addView(connect, LayoutParams(0, dp(52), 1f))
        buttons.addView(disconnect, LayoutParams(0, dp(52), 1f))
        addView(buttons)
        manageModels.text = "MANAGE MODELS"
        manageModels.isEnabled = false
        manageModels.setOnClickListener {
            val connection = saved ?: return@setOnClickListener
            modelsDialog?.dismiss()
            modelsDialog = TranscriberManagementDialog(context, connection).show()
        }
        addView(manageModels, LayoutParams(LayoutParams.MATCH_PARENT, dp(52)))
    }

    fun start() {
        if (active) return
        active = true
        status.setTextColor(Color.WHITE)
        status.text = "Loading connection…"
        request({ store.load() }, { connection ->
            saved = connection
            manageModels.isEnabled = connection != null
            if (connection == null) {
                status.text = "Not connected. Run docker compose exec transcriber python -m transcriber pair on your server."
                code.hint = "Pairing code (XXXX-XXXX)"
            } else {
                val uri = URI(connection.address)
                protocol.setSelection(if (uri.scheme == "http") 1 else 0)
                host.setText(uri.host)
                port.setText(if (uri.port == -1) "" else uri.port.toString())
                code.hint = "Paired (new code to replace)"
                status.text = "Paired. Tap Connect to test readiness."
            }
        }, "Unable to load saved connection. Disconnect to reset.")
    }

    fun stop() {
        active = false
        modelsDialog?.dismiss()
        modelsDialog = null
        manageModels.isEnabled = false
        generation++
        pending?.cancel(true)
        pending = null
        code.text.clear()
        saved = null
    }

    fun destroy() {
        stop()
        worker.shutdownNow()
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
        status.setTextColor(Color.WHITE)
        status.text = if (pairingCode == null) "Testing connection…" else "Pairing…"
        request({
            val candidate = if (pairingCode == null) requireNotNull(existing)
                else TranscriberConnection.pair(address, pairingCode)
            val capabilities = candidate.test()
            check(!Thread.currentThread().isInterrupted)
            store.save(candidate)
            candidate to capabilities
        }, { (candidate, capabilities) ->
            saved = candidate
            manageModels.isEnabled = true
            code.text.clear()
            code.hint = "Paired (new code to replace)"
            status.setTextColor(if (capabilities.ready) Color.rgb(76, 175, 80) else Color.WHITE)
            status.text = if (capabilities.ready) "Connected · Ready · Source: " + capabilities.sourceId
                else "Connected · Service not ready. Check source and model setup."
        }, "Connection failed. Check the address and service; generate a fresh pairing code if needed.")
    }

    private fun disconnect() {
        status.setTextColor(Color.WHITE)
        request({ store.clear() }, {
            saved = null
            manageModels.isEnabled = false
            code.text.clear()
            code.hint = "Pairing code (XXXX-XXXX)"
            status.text = "Disconnected"
        }, "Unable to clear saved connection.")
    }

    private fun setBusy(busy: Boolean) {
        protocol.isEnabled = !busy
        host.isEnabled = !busy
        port.isEnabled = !busy
        code.isEnabled = !busy
        connect.isEnabled = !busy
        disconnect.isEnabled = !busy
        manageModels.isEnabled = !busy && saved != null
    }

    private fun <T> request(action: () -> T, success: (T) -> Unit, failure: String) {
        if (!active) return
        val id = ++generation
        pending?.cancel(true)
        setBusy(true)
        pending = worker.submit {
            val result = runCatching(action)
            main.post {
                if (!active || generation != id) return@post
                pending = null
                setBusy(false)
                result.fold(success) { status.text = failure }
            }
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
}
