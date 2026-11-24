package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
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
    private val token = EditText(context)
    private val status = TextView(context)
    private val connect = Button(context)
    private val disconnect = Button(context)
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
        token.hint = "Transcriber token"
        token.setSingleLine(true)
        token.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        token.filters = arrayOf(InputFilter.LengthFilter(256))
        token.isSaveEnabled = false
        addView(token, LayoutParams(LayoutParams.MATCH_PARENT, dp(56)))
        status.textSize = 15f
        status.setTextColor(Color.WHITE)
        addView(status, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        connect.text = "TEST CONNECTION & SAVE"
        connect.setOnClickListener { connect() }
        disconnect.text = "DISCONNECT"
        disconnect.setOnClickListener { disconnect() }
        val buttons = LinearLayout(context)
        buttons.addView(connect, LayoutParams(0, dp(52), 1f))
        buttons.addView(disconnect, LayoutParams(0, dp(52), 1f))
        addView(buttons)
    }

    fun start() {
        if (active) return
        active = true
        status.text = "Loading connection…"
        request({ store.load() }, { connection ->
            saved = connection
            if (connection == null) {
                status.text = "Not connected"
                token.hint = "Transcriber token"
            } else {
                val uri = URI(connection.address)
                protocol.setSelection(if (uri.scheme == "http") 1 else 0)
                host.setText(uri.host)
                port.setText(if (uri.port == -1) "" else uri.port.toString())
                token.hint = "Saved token (enter to replace)"
                status.text = "Saved connection. Test to check readiness."
            }
        }, "Unable to load saved connection. Disconnect to reset.")
    }

    fun stop() {
        active = false
        generation++
        pending?.cancel(true)
        pending = null
        token.text.clear()
        saved = null
    }

    fun destroy() {
        stop()
        worker.shutdownNow()
    }

    private fun connect() {
        val candidate = try {
            val entered = token.text.toString()
            val existing = saved
            val address = BooksServer.address(protocol.selectedItem.toString(), host.text.toString(), port.text.toString(), false)
            val credential = entered.ifBlank {
                if (existing != null && existing.address == address) existing.token else ""
            }
            TranscriberConnection(address, credential.trim())
        } catch (_: Exception) {
            status.text = "Enter a valid host, port and transcriber token. HTTP requires a private IPv4 address."
            return
        }
        status.text = "Testing connection…"
        request({
            val capabilities = candidate.test()
            check(!Thread.currentThread().isInterrupted)
            store.save(candidate)
            capabilities
        }, { capabilities ->
            saved = candidate
            token.text.clear()
            token.hint = "Saved token (enter to replace)"
            status.text = if (capabilities.ready) "Connected · Ready · Source: " + capabilities.sourceId
                else "Connected · Service not ready. Check source and model setup."
        }, "Connection failed. Check host, port, token and server version.")
    }

    private fun disconnect() {
        request({ store.clear() }, {
            saved = null
            token.text.clear()
            token.hint = "Transcriber token"
            status.text = "Disconnected"
        }, "Unable to clear saved connection.")
    }

    private fun setBusy(busy: Boolean) {
        protocol.isEnabled = !busy
        host.isEnabled = !busy
        port.isEnabled = !busy
        token.isEnabled = !busy
        connect.isEnabled = !busy
        disconnect.isEnabled = !busy
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
