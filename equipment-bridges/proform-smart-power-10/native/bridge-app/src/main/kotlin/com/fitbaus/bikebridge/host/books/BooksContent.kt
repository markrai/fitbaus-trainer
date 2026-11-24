// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import com.fitbaus.bikebridge.host.arcade.ExerciseHud
import com.fitbaus.bikebridge.host.youtube.ThumbnailLoader
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal class BooksContent(context: Context) : LinearLayout(context) {
    val hud = ExerciseHud(context)
    private val store = BooksConnectionStore(context)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var pending: Future<*>? = null
    private var generation = 0L
    private var active = false
    private var busy = false
    private var connection: BooksConnection? = null
    private var loader: ThumbnailLoader? = null
    private var libraries = emptyList<BooksLibrary>()
    private var selected: BooksLibrary? = null
    private var page = 0
    private var next: Int? = null
    private var searching = false
    private var dialog: AlertDialog? = null
    private val items = ArrayList<BooksItem>()
    private val adapter = BookAdapter()
    private val message = text("", 16f)
    private val setup = ScrollView(context)
    private val address = EditText(context)
    private val authMethod = RadioGroup(context)
    private val loginChoice = RadioButton(context)
    private val keyChoice = RadioButton(context)
    private val username = EditText(context)
    private val password = EditText(context)
    private val apiKey = EditText(context)
    private val connect = button("CONNECT")
    private val forget = button("FORGET SAVED CONNECTION")
    private val browse = LinearLayout(context)
    private val libraryButton = button("LIBRARY")
    private val searchField = EditText(context)
    private val searchButton = button("SEARCH")
    private val clearSearch = button("CLEAR")
    private val disconnect = button("DISCONNECT")
    private val grid = GridView(context)
    private val previous = button("PREVIOUS")
    private val more = button("NEXT")
    private val pageLabel = text("", 16f)

    init {
        orientation = VERTICAL
        setBackgroundColor(Color.BLACK)
        addView(hud, LayoutParams(MATCH, WRAP))
        message.setPadding(dp(12), dp(8), dp(12), dp(8))
        addView(message, LayoutParams(MATCH, WRAP))
        buildSetup()
        buildBrowse()
        setup.visibility = GONE
        browse.visibility = GONE
    }

    fun start() {
        if (active) return
        active = true
        showSetup("Connecting to Audiobookshelf…")
        request(
            { store.load()?.let { SavedConnection(it, it.api.libraries(), null) } },
            { saved ->
                if (saved == null) showSetup("Connect your Audiobookshelf server.")
                else acceptConnection(saved)
            },
            { showSetup("Saved connection unavailable. Reconnect or forget it. " + failureMessage(it)) },
        )
    }

    fun stop() {
        active = false
        cancelRequest()
        dialog?.dismiss()
        dialog = null
        hideKeyboard()
        resetConnection()
        address.text.clear()
        apiKey.text.clear()
        username.text.clear()
        password.text.clear()
        searchField.text.clear()
        setup.visibility = GONE
        browse.visibility = GONE
        message.text = ""
    }

    fun destroy() {
        stop()
        worker.shutdownNow()
    }

    private fun buildSetup() {
        setup.isFillViewport = true
        val form = LinearLayout(context).apply {
            orientation = VERTICAL
            setPadding(dp(18), dp(8), dp(18), dp(8))
        }
        form.addView(text("Audiobookshelf", 26f), LayoutParams(MATCH, WRAP))
        form.addView(text("Enter your Audiobookshelf server address and sign in.", 17f), LayoutParams(MATCH, WRAP))
        address.hint = "https://books.example.net"
        address.setSingleLine(true)
        address.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        address.filters = arrayOf(InputFilter.LengthFilter(2048))
        loginChoice.id = View.generateViewId()
        loginChoice.text = "Username / password"
        keyChoice.id = View.generateViewId()
        keyChoice.text = "API key"
        authMethod.orientation = HORIZONTAL
        authMethod.addView(loginChoice)
        authMethod.addView(keyChoice)
        username.hint = "Username"
        username.setSingleLine(true)
        username.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        username.filters = arrayOf(InputFilter.LengthFilter(256))
        password.hint = "Password"
        password.setSingleLine(true)
        password.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        password.filters = arrayOf(InputFilter.LengthFilter(4096))
        password.isSaveEnabled = false
        apiKey.isSaveEnabled = false
        apiKey.hint = "Audiobookshelf API key"
        apiKey.setSingleLine(true)
        apiKey.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        apiKey.filters = arrayOf(InputFilter.LengthFilter(8192))
        form.addView(address, LayoutParams(MATCH, dp(56)))
        form.addView(authMethod, LayoutParams(MATCH, WRAP))
        form.addView(username, LayoutParams(MATCH, dp(56)))
        form.addView(password, LayoutParams(MATCH, dp(56)))
        form.addView(apiKey, LayoutParams(MATCH, dp(56)))
        authMethod.setOnCheckedChangeListener { _, checked ->
            val login = checked == loginChoice.id
            username.visibility = if (login) VISIBLE else GONE
            password.visibility = if (login) VISIBLE else GONE
            apiKey.visibility = if (login) GONE else VISIBLE
            if (login) apiKey.text.clear() else password.text.clear()
        }
        authMethod.check(loginChoice.id)
        connect.setOnClickListener { connect() }
        forget.setOnClickListener { forgetConnection() }
        form.addView(connect, LayoutParams(MATCH, dp(52)))
        form.addView(forget, LayoutParams(MATCH, dp(52)))
        setup.addView(form, FrameLayout.LayoutParams(MATCH, WRAP))
        addView(setup, LayoutParams(MATCH, 0, 1f))
    }

    private fun buildBrowse() {
        browse.orientation = VERTICAL
        val toolbar = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        libraryButton.setOnClickListener { chooseLibrary() }
        searchField.hint = "Search book titles"
        searchField.setSingleLine(true)
        searchField.inputType = InputType.TYPE_CLASS_TEXT
        searchField.filters = arrayOf(InputFilter.LengthFilter(200))
        searchField.imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        searchField.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_SEARCH) {
                search()
                true
            } else false
        }
        searchButton.setOnClickListener { search() }
        clearSearch.setOnClickListener {
            searchField.text.clear()
            selected?.let { loadPage(it, 0) }
        }
        disconnect.setOnClickListener {
            dialog = AlertDialog.Builder(context)
                .setTitle("Disconnect Audiobookshelf?")
                .setMessage("Forget the saved server and credentials on this bike.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Disconnect") { _, _ -> forgetConnection() }
                .show()
        }
        toolbar.addView(libraryButton, LayoutParams(dp(166), dp(52)))
        toolbar.addView(searchField, LayoutParams(0, dp(52), 1f))
        toolbar.addView(searchButton, LayoutParams(WRAP, dp(52)))
        toolbar.addView(clearSearch, LayoutParams(WRAP, dp(52)))
        toolbar.addView(disconnect, LayoutParams(WRAP, dp(52)))
        browse.addView(toolbar, LayoutParams(MATCH, WRAP))
        grid.numColumns = 5
        grid.stretchMode = GridView.STRETCH_COLUMN_WIDTH
        grid.horizontalSpacing = dp(10)
        grid.verticalSpacing = dp(12)
        grid.setPadding(dp(10), dp(8), dp(10), dp(8))
        grid.clipToPadding = false
        grid.adapter = adapter
        grid.setOnItemClickListener { _, _, position, _ ->
            items.getOrNull(position)?.let { item ->
                dialog = AlertDialog.Builder(context)
                    .setTitle(item.title)
                    .setMessage(listOf(item.author, duration(item.durationSeconds), "Playback will be available in the next integration phase.").filter { it.isNotBlank() }.joinToString("\n\n"))
                    .setPositiveButton("Close", null)
                    .show()
            }
        }
        browse.addView(grid, LayoutParams(MATCH, 0, 1f))
        val footer = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        previous.setOnClickListener { if (page > 0) selected?.let { loadPage(it, page - 1) } }
        more.setOnClickListener { next?.let { target -> selected?.let { loadPage(it, target) } } }
        pageLabel.gravity = Gravity.CENTER
        footer.addView(previous, LayoutParams(dp(132), dp(48)))
        footer.addView(pageLabel, LayoutParams(0, WRAP, 1f))
        footer.addView(more, LayoutParams(dp(132), dp(48)))
        browse.addView(footer, LayoutParams(MATCH, WRAP))
        addView(browse, LayoutParams(MATCH, 0, 1f))
    }

    private fun connect() {
        if (!active || busy) return
        val serverAddress = address.text.toString().trim()
        val server = try {
            BooksServer(serverAddress)
        } catch (_: Exception) {
            message.text = "Enter a valid HTTPS server address."
            return
        }
        val login = authMethod.checkedRadioButtonId == loginChoice.id
        val user = username.text.toString().trim()
        val secret = if (login) password.text.toString() else apiKey.text.toString().trim()
        if (login && user.isBlank()) {
            message.text = "Enter your Audiobookshelf username."
            return
        }
        if (!login && secret.isBlank()) {
            message.text = "Enter your Audiobookshelf API key."
            return
        }
        hideKeyboard()
        password.text.clear()
        message.text = "Checking connection…"
        request(
            {
                val credentials = if (login) BooksAuth(server).login(user, secret) else BooksCredentials(secret)
                val candidate = BooksConnection(serverAddress, credentials)
                SavedConnection(candidate, candidate.api.libraries(), store.prepare(candidate))
            },
            { saved ->
                try {
                    saved.envelope?.let { store.save(saved.connection, it) }
                    apiKey.text.clear()
                    acceptConnection(saved)
                } catch (_: Exception) {
                    message.text = "Could not securely save this connection."
                }
            },
            { message.text = failureMessage(it) },
        )
    }

    private fun acceptConnection(saved: SavedConnection) {
        resetConnection()
        connection = saved.connection
        loader = ThumbnailLoader(dp(160), fetchBitmap = BooksCoverFetcher(saved.connection)::fetch)
        libraries = saved.libraries
        setup.visibility = GONE
        browse.visibility = VISIBLE
        val first = libraries.firstOrNull()
        if (first == null) {
            message.text = "No audiobook libraries are available to this account."
            updateControls()
        } else {
            loadPage(first, 0)
        }
    }

    private fun chooseLibrary() {
        if (busy || libraries.isEmpty()) return
        dialog = AlertDialog.Builder(context)
            .setTitle("Audiobook library")
            .setItems(libraries.map { it.name }.toTypedArray()) { _, which ->
                searchField.text.clear()
                loadPage(libraries[which], 0)
            }
            .show()
    }

    private fun loadPage(library: BooksLibrary, target: Int) {
        val current = connection ?: return
        selected = library
        searching = false
        page = target
        next = null
        replaceItems(emptyList())
        message.text = "Loading " + library.name + "…"
        request(
            { current.api.items(library.id, target) },
            { result ->
                next = result.nextPage
                replaceItems(result.items)
                message.text = if (items.isEmpty()) "No audiobooks on this page." else library.name
            },
            { message.text = failureMessage(it) + " Select the library to retry." },
        )
    }

    private fun search() {
        if (!active || busy) return
        val library = selected ?: return
        val current = connection ?: return
        val query = searchField.text.toString().trim()
        if (query.isEmpty()) {
            loadPage(library, 0)
            return
        }
        hideKeyboard()
        searching = true
        next = null
        replaceItems(emptyList())
        message.text = "Searching…"
        request(
            { current.api.search(library.id, query) },
            { result ->
                replaceItems(result)
                message.text = if (items.isEmpty()) "No matching book titles." else "Search results (up to 20)"
            },
            { message.text = failureMessage(it) },
        )
    }

    private fun forgetConnection() {
        cancelRequest()
        try {
            store.clear()
            resetConnection()
            address.text.clear()
            apiKey.text.clear()
            username.text.clear()
            password.text.clear()
            searchField.text.clear()
            showSetup("Audiobookshelf disconnected.")
        } catch (_: Exception) {
            message.text = "Could not forget the saved connection."
        }
        updateControls()
    }

    private fun resetConnection() {
        loader?.shutdown()
        loader = null
        connection = null
        libraries = emptyList()
        selected = null
        page = 0
        next = null
        searching = false
        grid.adapter = null
        items.clear()
        grid.adapter = adapter
    }

    private fun showSetup(status: String) {
        setup.visibility = VISIBLE
        browse.visibility = GONE
        message.text = status
        updateControls()
    }

    private fun replaceItems(result: List<BooksItem>) {
        loader?.pause()
        items.clear()
        items.addAll(result)
        adapter.notifyDataSetChanged()
        grid.setSelection(0)
    }

    private fun cancelRequest() {
        generation += 1
        pending?.cancel(true)
        pending = null
        busy = false
    }

    private fun <T> request(action: () -> T, success: (T) -> Unit, failure: (Exception) -> Unit) {
        if (!active) return
        cancelRequest()
        val ticket = generation
        busy = true
        updateControls()
        pending = worker.submit {
            val result = try {
                Result.success(action())
            } catch (error: Exception) {
                Result.failure(error)
            }
            main.post {
                if (active && ticket == generation) {
                    pending = null
                    busy = false
                    result.fold(success, { error -> failure(error as? Exception ?: IllegalStateException()) })
                    updateControls()
                }
            }
        }
    }

    private fun updateControls() {
        connect.isEnabled = !busy
        address.isEnabled = !busy
        apiKey.isEnabled = !busy
        username.isEnabled = !busy
        password.isEnabled = !busy
        loginChoice.isEnabled = !busy
        keyChoice.isEnabled = !busy
        forget.isEnabled = !busy
        libraryButton.isEnabled = !busy && libraries.isNotEmpty()
        libraryButton.text = selected?.name ?: "LIBRARY"
        libraryButton.maxLines = 1
        libraryButton.ellipsize = TextUtils.TruncateAt.END
        searchField.isEnabled = !busy && selected != null
        searchButton.isEnabled = searchField.isEnabled
        clearSearch.isEnabled = !busy && selected != null
        disconnect.isEnabled = true
        previous.isEnabled = !busy && !searching && page > 0
        more.isEnabled = !busy && !searching && next != null
        pageLabel.text = if (searching) "Search" else if (selected != null) "Page " + (page + 1) else ""
    }

    private fun hideKeyboard() {
        val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        manager?.hideSoftInputFromWindow(windowToken, 0)
        address.clearFocus()
        apiKey.clearFocus()
        username.clearFocus()
        password.clearFocus()
        searchField.clearFocus()
    }

    private fun failureMessage(error: Exception): String = when (error) {
        is BooksHttpFailure -> when (error.status) {
            401, 403 -> "Sign-in rejected or session expired. Check your credentials or reconnect."
            else -> "Audiobookshelf returned HTTP " + error.status + "."
        }
        else -> "Could not contact Audiobookshelf or read its response."
    }

    private fun duration(seconds: Double): String {
        val minutes = (seconds / 60).toLong()
        return if (minutes > 0) "${minutes / 60}h ${minutes % 60}m" else ""
    }

    private fun button(label: String) = Button(context).apply { text = label }

    private fun text(label: String, size: Float) = TextView(context).apply {
        text = label
        textSize = size
        setTextColor(Color.WHITE)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

    private data class SavedConnection(val connection: BooksConnection, val libraries: List<BooksLibrary>, val envelope: String?)

    private inner class BookAdapter : BaseAdapter() {
        override fun getCount(): Int = items.size
        override fun getItem(position: Int): BooksItem = items[position]
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val card = convertView as? BookCard ?: BookCard()
            val item = getItem(position)
            card.title.text = item.title
            card.author.text = item.author
            card.contentDescription = item.title + ", " + item.author
            loader?.bind(card.cover, item.id)
            return card
        }
    }

    private inner class BookCard : LinearLayout(context) {
        val cover = ImageView(context)
        val title = text("", 16f)
        val author = text("", 13f)

        init {
            orientation = VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(4), dp(4), dp(4), dp(4))
            cover.scaleType = ImageView.ScaleType.FIT_CENTER
            cover.setBackgroundColor(Color.rgb(30, 30, 30))
            addView(cover, LayoutParams(MATCH, dp(128)))
            title.maxLines = 2
            title.ellipsize = TextUtils.TruncateAt.END
            title.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            addView(title, LayoutParams(MATCH, dp(44)))
            author.setTextColor(Color.LTGRAY)
            author.maxLines = 1
            author.ellipsize = TextUtils.TruncateAt.END
            author.gravity = Gravity.CENTER
            addView(author, LayoutParams(MATCH, dp(24)))
        }
    }

    private companion object {
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
    }
}
