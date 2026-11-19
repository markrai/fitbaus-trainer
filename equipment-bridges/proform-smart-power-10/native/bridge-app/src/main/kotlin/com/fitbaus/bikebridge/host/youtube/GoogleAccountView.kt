// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView

internal class GoogleAccountView(
    context: Context,
    private val account: GoogleAccountController,
    private val onVideoSelected: (VideoSummary) -> Unit,
    private val onHomeRequested: () -> Unit,
) : LinearLayout(context) {
    private sealed class Row {
        data class Collection(val entry: GoogleEntry) : Row()
        data class Video(val video: VideoSummary) : Row()
    }

    private enum class Section { Subscriptions, Playlists, Channel, Playlist }

    private val title = text("", 20f)
    private val message = text("", 18f)
    private val authorizationPanel = LinearLayout(context)
    private val qrImage = ImageView(context)
    private val qrHint = text("", 18f)
    private val verificationAddress = text("", 18f)
    private val verificationCode = text("", 30f)
    private val qrFallback = text("", 15f)
    private var renderedScanUrl: String? = null
    private val homeBack = button("‹")
    private val subs = button("SUBSCRIPTIONS")
    private val playlists = button("PLAYLISTS")
    private val login = button("CONNECT GOOGLE")
    private val changeClient = button("CHANGE CLIENT")
    private val logout = button("SIGN OUT")
    private val back = button("BACK")
    private val more = button("MORE")
    private val list = ListView(context)
    private val rows = ArrayList<Row>()
    private val adapter = RowsAdapter()
    private var section = Section.Subscriptions
    private var selected: GoogleEntry? = null
    private var next: String? = null
    private var requestId = 0L
    private var loaded = false
    private var busy = false

    init {
        orientation = VERTICAL
        setBackgroundColor(Color.BLACK)
        visibility = GONE
        val bar = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        homeBack.contentDescription = "Back to YouTube videos"
        homeBack.setOnClickListener { onHomeRequested() }
        bar.addView(homeBack, LayoutParams(dp(64), dp(56)))
        bar.addView(title, LayoutParams(0, dp(56), 1f))
        subs.setOnClickListener { showSubscriptions() }
        playlists.setOnClickListener { showPlaylists() }
        login.setOnClickListener {
            when {
                account.status.phase == GoogleAccountPhase.Authorizing -> account.cancelAuthorization()
                account.hasStoredClient() -> account.requestStoredAuthorization()
                else -> showConfiguration()
            }
        }
        changeClient.setOnClickListener { showConfiguration() }
        logout.setOnClickListener { confirmSignOut() }
        bar.addView(subs, LayoutParams(dp(170), dp(56)))
        bar.addView(playlists, LayoutParams(dp(150), dp(56)))
        bar.addView(login, LayoutParams(dp(180), dp(56)))
        bar.addView(changeClient, LayoutParams(dp(170), dp(56)))
        bar.addView(logout, LayoutParams(dp(120), dp(56)))
        addView(bar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        message.setPadding(dp(12), dp(10), dp(12), dp(10))
        addView(message, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        buildAuthorizationPanel()
        list.adapter = adapter
        list.setBackgroundColor(Color.BLACK)
        list.dividerHeight = dp(1)
        list.setOnItemClickListener { _, _, position, _ ->
            when (val row = rows.getOrNull(position)) {
                is Row.Collection -> showCollection(row.entry)
                is Row.Video -> onVideoSelected(row.video)
                null -> Unit
            }
        }
        addView(list, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        val bottom = LinearLayout(context).apply { orientation = HORIZONTAL }
        back.setOnClickListener {
            if (section == Section.Channel) showSubscriptions() else showPlaylists()
        }
        more.setOnClickListener { loadNext() }
        bottom.addView(back, LayoutParams(dp(150), dp(56)))
        bottom.addView(more, LayoutParams(dp(150), dp(56)))
        addView(bottom, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(60)))
        account.listener = { status -> onAccountStatus(status) }
        renderStatus(account.status)
    }

    fun open(autoAuthorize: Boolean = true) {
        visibility = VISIBLE
        if (autoAuthorize) account.ensureAuthorizationOnOpen()
        if (account.status.phase == GoogleAccountPhase.Connected && !loaded) showSubscriptions()
        renderStatus(account.status)
    }

    fun close() {
        visibility = GONE
        clearQr()
    }

    fun reset() {
        requestId += 1
        rows.clear()
        adapter.notifyDataSetChanged()
        loaded = false
        next = null
        busy = false
        renderStatus(account.status)
    }

    private fun onAccountStatus(status: GoogleAccountStatus) {
        if (status.phase == GoogleAccountPhase.Connected && visibility == VISIBLE && !loaded) {
            showSubscriptions()
        } else if (status.phase == GoogleAccountPhase.SignedOut ||
            status.phase == GoogleAccountPhase.Error) {
            reset()
        } else {
            renderStatus(status)
        }
    }

    private fun renderStatus(status: GoogleAccountStatus) {
        val connected = status.phase == GoogleAccountPhase.Connected
        subs.visibility = if (connected) VISIBLE else GONE
        playlists.visibility = if (connected) VISIBLE else GONE
        logout.visibility = if (connected) VISIBLE else GONE
        val hasClient = account.hasStoredClient()
        login.visibility = if (connected || status.phase == GoogleAccountPhase.Connecting) GONE else VISIBLE
        changeClient.visibility = if (!connected && hasClient && status.phase != GoogleAccountPhase.Connecting) VISIBLE else GONE
        login.text = when {
            status.phase == GoogleAccountPhase.Authorizing -> "CANCEL"
            hasClient -> "GET NEW CODE"
            else -> "CONNECT GOOGLE"
        }
        list.visibility = if (connected) VISIBLE else GONE
        back.visibility = if (connected && (section == Section.Channel || section == Section.Playlist)) VISIBLE else GONE
        more.visibility = if (connected && next != null) VISIBLE else GONE
        more.isEnabled = !busy
        val statusText = when (status.phase) {
            GoogleAccountPhase.SignedOut ->
                if (hasClient) {
                    "Google OAuth client is saved on this bike. Select GET NEW CODE to authorize another account."
                } else {
                    "Connect your Google account to browse your subscribed channels and playlists."
                }
            GoogleAccountPhase.Connecting -> status.message
            GoogleAccountPhase.Authorizing ->
                "Scan with your phone, then approve YouTube read-only access."
            GoogleAccountPhase.Error -> status.message
            GoogleAccountPhase.Connected -> when {
                busy -> "Loading…"
                rows.isEmpty() -> "Nothing found here."
                else -> when (section) {
                    Section.Subscriptions -> "Subscribed channels"
                    Section.Playlists -> "Your playlists"
                    Section.Channel -> "Recent uploads"
                    Section.Playlist -> "Playlist videos"
                }
            }
        }
        message.text = statusText
        renderAuthorization(status)
        title.text = selected?.title?.takeIf { section == Section.Channel || section == Section.Playlist } ?: ""
    }

    private fun buildAuthorizationPanel() {
        authorizationPanel.orientation = HORIZONTAL
        authorizationPanel.gravity = Gravity.CENTER_VERTICAL
        authorizationPanel.setPadding(dp(18), dp(12), dp(18), dp(12))
        authorizationPanel.visibility = GONE

        qrImage.setBackgroundColor(Color.WHITE)
        qrImage.scaleType = ImageView.ScaleType.FIT_CENTER
        qrImage.contentDescription = "Scan to open Google device authorization on your phone"
        authorizationPanel.addView(qrImage, LayoutParams(dp(224), dp(224)))

        val instructions = LinearLayout(context).apply {
            orientation = VERTICAL
            setPadding(dp(24), 0, 0, 0)
        }
        qrHint.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        instructions.addView(qrHint, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        verificationAddress.setTextIsSelectable(true)
        verificationAddress.setPadding(0, dp(10), 0, dp(6))
        instructions.addView(verificationAddress, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        verificationCode.typeface = Typeface.MONOSPACE
        verificationCode.setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
        verificationCode.setTextIsSelectable(true)
        verificationCode.setSingleLine(true)
        instructions.addView(verificationCode, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        qrFallback.setPadding(0, dp(8), 0, 0)
        instructions.addView(qrFallback, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        authorizationPanel.addView(instructions, LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addView(authorizationPanel, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun renderAuthorization(status: GoogleAccountStatus) {
        if (status.phase != GoogleAccountPhase.Authorizing) {
            authorizationPanel.visibility = GONE
            clearQr()
            return
        }
        if (visibility != VISIBLE) {
            authorizationPanel.visibility = GONE
            clearQr()
            return
        }
        authorizationPanel.visibility = VISIBLE
        verificationAddress.text = status.verificationUrl
        verificationCode.text = status.userCode
        val url = status.verificationScanUrl.ifEmpty { status.verificationUrl }
        val direct = url != status.verificationUrl
        qrHint.text = if (direct) "SCAN TO OPEN GOOGLE" else "SCAN, THEN ENTER CODE"
        qrFallback.text = if (direct) {
            "Google supplied a direct sign-in link. Confirm the code on your phone if requested."
        } else {
            "The QR opens Google's website. Enter the code above on your phone."
        }
        if (renderedScanUrl != url) {
            qrImage.setImageDrawable(null)
            renderedScanUrl = url
            val qr = runCatching { GoogleDeviceQr.bitmap(url) }.getOrNull()
            qrImage.visibility = if (qr == null) GONE else VISIBLE
            if (qr != null) qrImage.setImageBitmap(qr)
            if (qr == null) qrFallback.text = "QR unavailable. Open the URL above and enter the code manually."
        }
    }

    private fun clearQr() {
        qrImage.setImageDrawable(null)
        renderedScanUrl = null
        verificationCode.text = ""
        verificationAddress.text = ""
    }

    private fun showSubscriptions() {
        section = Section.Subscriptions
        selected = null
        loadNext(reset = true)
    }

    private fun showPlaylists() {
        section = Section.Playlists
        selected = null
        loadNext(reset = true)
    }

    private fun showCollection(entry: GoogleEntry) {
        section = if (section == Section.Subscriptions) Section.Channel else Section.Playlist
        selected = entry
        loadNext(reset = true)
    }

    private fun loadNext(reset: Boolean = false) {
        if (account.status.phase != GoogleAccountPhase.Connected) return
        if (busy && !reset) return
        if (reset) {
            rows.clear()
            adapter.notifyDataSetChanged()
            next = null
        }
        val page = next
        if (!reset && page == null && loaded) return
        busy = true
        loaded = true
        val current = ++requestId
        renderStatus(account.status)
        when (section) {
            Section.Subscriptions -> account.subscriptions(page) { result ->
                if (current == requestId) appendCollections(result)
            }
            Section.Playlists -> account.playlists(page) { result ->
                if (current == requestId) appendCollections(result)
            }
            Section.Channel -> {
                val entry = selected ?: return
                account.uploads(entry.id, page) { result ->
                    if (current == requestId) appendVideos(result)
                }
            }
            Section.Playlist -> {
                val entry = selected ?: return
                account.playlistItems(entry.id, page) { result ->
                    if (current == requestId) appendVideos(result)
                }
            }
        }
    }

    private fun appendCollections(result: Result<GooglePage<GoogleEntry>>) {
        busy = false
        result.fold(
            onSuccess = {
                rows.addAll(it.items.map { entry -> Row.Collection(entry) })
                next = it.next
                adapter.notifyDataSetChanged()
                renderStatus(account.status)
            },
            onFailure = {
                next = null
                renderStatus(account.status)
                message.text = "Couldn't retrieve your YouTube list. Try the tab again."
            },
        )
    }

    private fun appendVideos(result: Result<GooglePage<VideoSummary>>) {
        busy = false
        result.fold(
            onSuccess = {
                rows.addAll(it.items.map { video -> Row.Video(video) })
                next = it.next
                adapter.notifyDataSetChanged()
                renderStatus(account.status)
            },
            onFailure = {
                next = null
                renderStatus(account.status)
                message.text = "Couldn't load these videos. Select the channel or playlist again."
            },
        )
    }

    private fun showConfiguration() {
        val content = LinearLayout(context).apply {
            orientation = VERTICAL
            setPadding(dp(20), dp(12), dp(20), 0)
        }
        val id = EditText(context).apply {
            hint = "TV OAuth client ID"
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT
        }
        val secret = EditText(context).apply {
            hint = "TV OAuth client secret"
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        content.addView(id)
        content.addView(secret)
        AlertDialog.Builder(context)
            .setTitle("Google YouTube read-only sign-in")
            .setMessage("Create a TVs and Limited Input devices OAuth client in Google Cloud and enable YouTube Data API v3. These credentials stay on this console.")
            .setView(content)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Start") { _, _ ->
                account.signIn(GoogleClient(id.text.toString().trim(), secret.text.toString().trim()))
            }
            .show()
    }

    private fun confirmSignOut() {
        AlertDialog.Builder(context)
            .setTitle("Disconnect Google account?")
            .setMessage("Remove this console's saved Google authorization and ask Google to revoke it?")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Disconnect") { _, _ ->
                account.signOut()
                reset()
            }
            .show()
    }

    private fun text(value: String, size: Float): TextView = TextView(context).apply {
        text = value
        textSize = size
        setTextColor(Color.WHITE)
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun button(value: String): TextView = text(value, 15f).apply {
        gravity = Gravity.CENTER
        setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        setBackgroundColor(Color.rgb(32, 32, 32))
        isClickable = true
        isFocusable = true
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

    private inner class RowsAdapter : BaseAdapter() {
        override fun getCount(): Int = rows.size
        override fun getItem(position: Int): Any = rows[position]
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val view = (convertView as? TextView) ?: text("", 18f).apply {
                setPadding(dp(20), dp(12), dp(20), dp(12))
                minHeight = dp(64)
            }
            view.text = when (val row = rows[position]) {
                is Row.Collection -> row.entry.title
                is Row.Video -> row.video.title + "\n" + (row.video.channel ?: "")
            }
            return view
        }
    }
}
