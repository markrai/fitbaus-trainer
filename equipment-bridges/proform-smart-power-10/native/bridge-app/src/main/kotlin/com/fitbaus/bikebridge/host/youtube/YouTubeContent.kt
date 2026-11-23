// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import android.app.AlertDialog
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.text.TextUtils
import android.view.Gravity
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import com.fitbaus.bikebridge.host.R
import com.fitbaus.bikebridge.host.arcade.ExerciseHud

internal class YouTubeContent(
    context: Context,
    private val prefs: SharedPreferences,
    private val brightness: BrightnessControl,
    private val onRestoreRequested: () -> Unit = {},
    private val onVoiceSearchRequested: () -> Unit = {},
    private val onVoiceSearchCancelled: () -> Unit = {},
) : LinearLayout(context) {
    val hud: ExerciseHud = ExerciseHud(context)
    private val handler = Handler(Looper.getMainLooper())
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val loader = ThumbnailLoader(dp(THUMB_WIDTH_DP))
    private val videoOutput: View = if (YouTubeVideoOutput.useTextureView(Build.VERSION.SDK_INT)) TextureView(context) else SurfaceView(context)
    private val mediaSources by lazy { YouTubeMediaSources() }

    private val accountStore = AndroidGoogleAccountStore(context)
    private val googleApi = GoogleYouTubeApi(GoogleUrlConnectionHttp())

    val session: YouTubeSession = YouTubeSession(
        catalogFactory = { GoogleSubscriptionFeedCatalog(NewPipeYouTubeCatalog(), accountStore, googleApi) },
        runner = ExecutorRunner("fitbaus-youtube"),
        main = MainThread { block -> handler.post { block() } },
        engineFactory = PlayerEngineFactory { listener -> ExoPlayerEngine(context, videoOutput, listener) },
        preparer = MediaPreparer { handle, plan -> mediaSources.prepare(handle, plan) },
        initialMaxHeight = prefs.getInt(KEY_MAX_HEIGHT, YouTubeStreamSelector.DEFAULT_MAX_HEIGHT),
        onMaxHeightChanged = { prefs.edit().putInt(KEY_MAX_HEIGHT, it).apply() },
        feedTitle = { if (accountStore.hasAccount()) "From your channels" else "Trending" },
    )

    private val accountController = GoogleAccountController(
        store = accountStore,
        api = googleApi,
        runner = ExecutorRunner("fitbaus-google-account"),
        main = MainThread { block -> handler.post { block() } },
    )
    private var accountOpen = false
    private var discoveryActive = false
    private var previousAccountState: Boolean? = null
    private val accountView = GoogleAccountView(
        context, accountController,
        onVideoSelected = { video -> session.open(video) },
        onHomeRequested = { returnToHome() },
    )

    private val resultsScreen = LinearLayout(context)
    private val searchField = EditText(context)
    private val searchClear = label("×", 30f, PRIMARY)
    private val searchMic = ImageView(context)
    private val voiceStatus = label("", 14f, PRIMARY)
    private val listTitle = label("", 14f, MUTE)
    private val channelBackButton = button("‹ BACK")
    private lateinit var browseToolbar: LinearLayout
    private val discoveryButton = button("DISCOVER")
    private val grid = GridView(context)
    private val adapter = VideoAdapter()
    private val listOverlay = LinearLayout(context)
    private val listMessage = label("", 18f, PRIMARY)
    private val listRetry = button("RETRY")
    private val moreStatus = label("", 14f, MUTE)

    private val playerScreen = LinearLayout(context)
    private val videoTitle = label("", 18f, PRIMARY)
    private val channelButton = FrameLayout(context)
    private val channelInitial = label("", 20f, PRIMARY)
    private val channelAvatar = ImageView(context)
    private val qualityButton = button("360p")
    private val videoFrame = AspectFrame(context)
    private lateinit var fullScreenVideoArea: FrameLayout
    private var floating = false
    private val captionsView = label("", 22f, PRIMARY)
    private val captionsButton = button("CC")
    private val playbackFeedback = ImageView(context)
    private val hidePlaybackFeedback = Runnable { playbackFeedback.visibility = GONE }
    private val playerOverlay = LinearLayout(context)
    private val playerMessage = label("", 18f, PRIMARY)
    private val playerRetry = button("RETRY")
    private val playButton = button("PAUSE")
    private val positionText = label("0:00", 16f, PRIMARY)
    private val durationText = label("0:00", 16f, PRIMARY)
    private val seekBar = SeekBar(context)
    private val brightnessBar = SeekBar(context)
    private val volumeSlider = VerticalSlider(context)
    private val volumeText = label("", 14f, LABEL)
    private var seeking = false
    private var renderedItems: List<VideoSummary>? = null
    private var renderedChannelAvatarUrl: String? = null
    private var ticking = false

    private val ticker = object : Runnable {
        override fun run() {
            session.tick()
            refreshVolume()
            if (ticking) handler.postDelayed(this, TICK_MS)
        }
    }

    init {
        orientation = VERTICAL
        setBackgroundColor(BACKGROUND)
        addView(hud, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val host = FrameLayout(context)
        val hostLp = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        hostLp.topMargin = dp(8)
        addView(host, hostLp)
        buildResults()
        buildPlayer()
        host.addView(resultsScreen, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        host.addView(playerScreen, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        host.addView(accountView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        session.listener = { render(it) }
        render(session.state)
    }

    fun start() {
        if (floating) {
            restoreFullPlayer()
            return
        }
        refreshVolume()
        refreshBrightness()
        accountController.start()
        val connected = accountController.hasAccount()
        val reloadHome = YouTubeHomeNavigation.shouldReload(previousAccountState, connected, session.state.browse)
        session.start(loadDefault = !reloadHome)
        if (reloadHome) session.showTrending()
        previousAccountState = connected
        accountOpen = false
        discoveryActive = false
        accountView.close()
        render(session.state)
        adapter.notifyDataSetChanged()
    }

    fun importGoogleCredentials(nonce: String) {
        accountOpen = true
        accountView.open(autoAuthorize = false)
        runCatching { YouTubeCredentialsImport.loadAndDelete(context, nonce) }.fold(
            onSuccess = { client ->
                accountController.signIn(client) { stored ->
                    YouTubeCredentialsImport.acknowledge(context, nonce, stored)
                }
            },
            onFailure = {
                YouTubeCredentialsImport.acknowledge(context, nonce, false)
                android.widget.Toast.makeText(context, "Google OAuth import failed", android.widget.Toast.LENGTH_LONG).show()
            },
        )
        render(session.state)
    }

    fun minimizeInto(floatingSlot: FrameLayout): Boolean {
        val current = session.state
        if (!YouTubeFloatingPlayer.canFloat(current)) {
            stop()
            return false
        }
        if (floating) return true
        hideKeyboard()
        clearPlaybackFeedback()
        stopTicker()
        (videoFrame.parent as? ViewGroup)?.removeView(videoFrame)
        floatingSlot.addView(
            videoFrame,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER),
        )
        floating = true
        styleCaptionsForVideoSize()
        render(current)
        return true
    }

    private fun restoreFullPlayer() {
        if (!floating) return
        (videoFrame.parent as? ViewGroup)?.removeView(videoFrame)
        fullScreenVideoArea.addView(
            videoFrame,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER),
        )
        floating = false
        videoFrame.requestLayout()
        styleCaptionsForVideoSize()
        render(session.state)
    }

    private fun styleCaptionsForVideoSize() {
        captionsView.textSize = if (floating) 12f else 22f
        captionsView.maxLines = if (floating) 8 else 3
        val horizontal = dp(if (floating) 6 else 12)
        val vertical = dp(if (floating) 2 else 5)
        captionsView.setPadding(horizontal, vertical, horizontal, vertical)
    }

    fun stop() {
        restoreFullPlayer()
        hideKeyboard()
        clearPlaybackFeedback()
        stopTicker()
        accountView.close()
        accountController.stop()
        setVoiceSearchStatus(null)
        session.stop()
        loader.pause()
    }

    fun destroy() {
        restoreFullPlayer()
        clearPlaybackFeedback()
        stopTicker()
        accountController.destroy()
        session.destroy()
        loader.shutdown()
    }

    private fun buildResults() {
        resultsScreen.orientation = VERTICAL
        val bar = LinearLayout(context)
        browseToolbar = bar
        bar.orientation = HORIZONTAL
        bar.gravity = Gravity.CENTER_VERTICAL
        searchField.hint = "Search YouTube"
        searchField.setHintTextColor(MUTE)
        searchField.setTextColor(PRIMARY)
        searchField.textSize = 18f
        searchField.setSingleLine(true)
        searchField.inputType = InputType.TYPE_CLASS_TEXT
        searchField.imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        searchField.background = outline(DIVIDER, FIELD)
        searchField.setPadding(dp(14), 0, dp(TOUCH_DP * 2), 0)
        searchField.setOnEditorActionListener { _, actionId, event ->
            val enter = event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
            if (actionId == EditorInfo.IME_ACTION_SEARCH || enter) {
                submitSearch()
                true
            } else {
                false
            }
        }
        val fieldSlot = FrameLayout(context)
        fieldSlot.addView(searchField, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(TOUCH_DP)))
        searchClear.gravity = Gravity.CENTER
        searchClear.contentDescription = "Clear search"
        searchClear.visibility = GONE
        searchClear.setOnClickListener { returnToHome() }
        val clearLp = FrameLayout.LayoutParams(dp(TOUCH_DP), dp(TOUCH_DP), Gravity.END or Gravity.CENTER_VERTICAL)
        clearLp.rightMargin = dp(TOUCH_DP)
        fieldSlot.addView(searchClear, clearLp)
        searchMic.setImageResource(R.drawable.ic_mic)
        searchMic.scaleType = ImageView.ScaleType.CENTER
        searchMic.contentDescription = "Search YouTube by voice"
        searchMic.isClickable = true
        searchMic.isFocusable = true
        searchMic.setOnClickListener { onVoiceSearchRequested() }
        fieldSlot.addView(searchMic, FrameLayout.LayoutParams(dp(TOUCH_DP), dp(TOUCH_DP), Gravity.END or Gravity.CENTER_VERTICAL))
        searchField.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                searchClear.visibility = if (s.isNullOrEmpty()) GONE else VISIBLE
            }
            override fun afterTextChanged(s: Editable?) {}
        })
        bar.addView(fieldSlot, LayoutParams(0, dp(TOUCH_DP), 1f))
        val myYouTube = button("MY YOUTUBE")
        myYouTube.setOnClickListener {
            hideKeyboard()
            accountOpen = true
            accountView.open()
            render(session.state)
        }
        bar.addView(myYouTube, spaced(LayoutParams(dp(170), dp(TOUCH_DP))))
        resultsScreen.addView(bar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        voiceStatus.setPadding(dp(12), dp(7), dp(12), dp(7))
        voiceStatus.setBackgroundColor(FIELD)
        voiceStatus.visibility = GONE
        resultsScreen.addView(voiceStatus, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        listTitle.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        listTitle.maxLines = 1
        listTitle.ellipsize = TextUtils.TruncateAt.END
        val sectionBar = LinearLayout(context)
        sectionBar.orientation = HORIZONTAL
        sectionBar.gravity = Gravity.CENTER_VERTICAL
        channelBackButton.visibility = GONE
        channelBackButton.contentDescription = "Back to previous YouTube results"
        channelBackButton.setOnClickListener {
            grid.setSelection(0)
            session.backFromChannel()
        }
        sectionBar.addView(channelBackButton, LayoutParams(dp(160), dp(44)))
        sectionBar.addView(listTitle, LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        discoveryButton.contentDescription = "Show related video suggestions"
        discoveryButton.setOnClickListener {
            discoveryActive = !discoveryActive
            grid.setSelection(0)
            if (discoveryActive) session.loadRecommendations()
            render(session.state)
        }
        sectionBar.addView(discoveryButton, spaced(LayoutParams(dp(252), dp(44))))
        val titleLp = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        titleLp.topMargin = dp(6)
        titleLp.bottomMargin = dp(6)
        resultsScreen.addView(sectionBar, titleLp)

        val body = FrameLayout(context)
        grid.numColumns = GridView.AUTO_FIT
        grid.columnWidth = dp(COLUMN_DP)
        grid.stretchMode = GridView.STRETCH_COLUMN_WIDTH
        grid.horizontalSpacing = dp(12)
        grid.verticalSpacing = dp(14)
        grid.selector = ColorDrawable(PRESSED)
        grid.isDrawSelectorOnTop = true
        grid.cacheColorHint = Color.TRANSPARENT
        grid.adapter = adapter
        grid.setOnItemClickListener { _, _, position, _ ->
            hideKeyboard()
            adapter.itemAt(position)?.let { session.open(it) }
        }
        grid.setOnScrollListener(object : AbsListView.OnScrollListener {
            override fun onScrollStateChanged(view: AbsListView?, scrollState: Int) {}

            override fun onScroll(view: AbsListView?, firstVisibleItem: Int, visibleItemCount: Int, totalItemCount: Int) {
                if (totalItemCount > 0 && firstVisibleItem + visibleItemCount >= totalItemCount - PREFETCH_ITEMS) {
                    if (discoveryActive) session.loadMoreRecommendations(false) else session.loadMore(false)
                }
            }
        })
        body.addView(grid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        listOverlay.orientation = VERTICAL
        listOverlay.gravity = Gravity.CENTER
        listMessage.gravity = Gravity.CENTER
        listOverlay.addView(listMessage, LayoutParams(dp(720), ViewGroup.LayoutParams.WRAP_CONTENT))
        listRetry.setOnClickListener {
            if (discoveryActive) {
                if (session.state.recommendations.status == ListStatus.Empty && session.state.recommendations.canLoadMore) {
                    session.loadMoreRecommendations(true)
                } else session.loadRecommendations(force = true)
            } else session.retry()
        }
        val retryLp = LayoutParams(dp(180), dp(TOUCH_DP))
        retryLp.topMargin = dp(16)
        listOverlay.addView(listRetry, retryLp)
        body.addView(listOverlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        resultsScreen.addView(body, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        moreStatus.gravity = Gravity.CENTER
        moreStatus.minHeight = dp(40)
        moreStatus.setOnClickListener {
            if (discoveryActive) session.loadMoreRecommendations(true) else session.loadMore(true)
        }
        resultsScreen.addView(moreStatus, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun buildPlayer() {
        playerScreen.orientation = VERTICAL
        val top = LinearLayout(context)
        top.orientation = HORIZONTAL
        top.gravity = Gravity.CENTER_VERTICAL
        val back = button("‹ RESULTS")
        back.setOnClickListener { session.back() }
        top.addView(back, LayoutParams(dp(170), dp(TOUCH_DP)))
        videoTitle.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        videoTitle.maxLines = 1
        videoTitle.ellipsize = TextUtils.TruncateAt.END
        top.addView(videoTitle, spaced(LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)))
        channelButton.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(FIELD)
        }
        channelButton.clipToOutline = true
        channelButton.visibility = GONE
        channelButton.isClickable = true
        channelButton.isFocusable = true
        channelInitial.gravity = Gravity.CENTER
        channelInitial.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        channelButton.addView(
            channelInitial,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        channelAvatar.scaleType = ImageView.ScaleType.CENTER_CROP
        channelButton.addView(
            channelAvatar,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        channelButton.setOnClickListener {
            val video = session.state.playback.video ?: return@setOnClickListener
            if (session.openChannel(video)) {
                discoveryActive = false
                accountOpen = false
                hideKeyboard()
                grid.setSelection(0)
                render(session.state)
            }
        }
        top.addView(channelButton, spaced(LayoutParams(dp(48), dp(48))))
        qualityButton.setOnClickListener { chooseQuality() }
        top.addView(qualityButton, spaced(LayoutParams(dp(150), dp(TOUCH_DP))))
        playerScreen.addView(top, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val area = FrameLayout(context)
        fullScreenVideoArea = area
        area.setBackgroundColor(Color.BLACK)
        videoFrame.addView(videoOutput, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        captionsView.gravity = Gravity.CENTER
        captionsView.setBackgroundColor(Color.argb(165, 0, 0, 0))
        captionsView.setShadowLayer(3f, 0f, 2f, Color.BLACK)
        captionsView.setPadding(dp(12), dp(5), dp(12), dp(5))
        captionsView.maxLines = 3
        captionsView.visibility = GONE
        videoFrame.addView(captionsView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        val feedbackBackground = GradientDrawable()
        feedbackBackground.shape = GradientDrawable.OVAL
        feedbackBackground.setColor(Color.argb(175, 0, 0, 0))
        playbackFeedback.background = feedbackBackground
        playbackFeedback.setPadding(dp(20), dp(20), dp(20), dp(20))
        playbackFeedback.visibility = GONE
        videoFrame.addView(playbackFeedback, FrameLayout.LayoutParams(dp(84), dp(84), Gravity.CENTER))
        videoFrame.setOnClickListener {
            if (floating) onRestoreRequested() else onPlaybackToggle()
        }
        area.addView(videoFrame, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        playerOverlay.orientation = VERTICAL
        playerOverlay.gravity = Gravity.CENTER
        playerOverlay.setBackgroundColor(Color.argb(150, 0, 0, 0))
        playerMessage.gravity = Gravity.CENTER
        playerOverlay.addView(playerMessage, LayoutParams(dp(720), ViewGroup.LayoutParams.WRAP_CONTENT))
        playerRetry.setOnClickListener { session.retry() }
        val retryLp = LayoutParams(dp(180), dp(TOUCH_DP))
        retryLp.topMargin = dp(16)
        playerOverlay.addView(playerRetry, retryLp)
        area.addView(playerOverlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val stage = LinearLayout(context)
        stage.orientation = HORIZONTAL
        stage.addView(area, LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        stage.addView(buildVolumeColumn(), LayoutParams(dp(VOLUME_COLUMN_DP), ViewGroup.LayoutParams.MATCH_PARENT))
        val stageLp = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        stageLp.topMargin = dp(8)
        stageLp.bottomMargin = dp(8)
        playerScreen.addView(stage, stageLp)

        val controls = LinearLayout(context)
        controls.orientation = HORIZONTAL
        controls.gravity = Gravity.CENTER_VERTICAL
        playButton.setOnClickListener { onPlaybackToggle() }
        controls.addView(playButton, LayoutParams(dp(140), dp(TOUCH_DP)))
        captionsButton.contentDescription = "Captions unavailable"
        captionsButton.background = StateListDrawable().apply {
            addState(intArrayOf(-android.R.attr.state_enabled), outline(DIVIDER, FIELD))
            addState(intArrayOf(android.R.attr.state_activated), outline(CAPTIONS_ACTIVE, FIELD))
            addState(intArrayOf(android.R.attr.state_pressed), outline(PRESSED, PRESSED))
            addState(intArrayOf(), outline(MUTE, FIELD))
        }
        captionsButton.setOnClickListener { session.toggleCaptions() }
        controls.addView(captionsButton, spaced(LayoutParams(dp(90), dp(TOUCH_DP))))
        positionText.setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
        positionText.gravity = Gravity.END or Gravity.CENTER_VERTICAL
        controls.addView(positionText, spaced(LayoutParams(dp(92), ViewGroup.LayoutParams.WRAP_CONTENT)))
        seekBar.setPadding(dp(18), dp(14), dp(18), dp(14))
        seekBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser) positionText.text = YouTubeFormat.clock(progress * 1000L)
            }

            override fun onStartTrackingTouch(bar: SeekBar) {
                seeking = true
            }

            override fun onStopTrackingTouch(bar: SeekBar) {
                seeking = false
                session.seekTo(bar.progress * 1000L)
            }
        })
        controls.addView(seekBar, LayoutParams(0, dp(TOUCH_DP), 1f))
        durationText.setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
        controls.addView(durationText, LayoutParams(dp(92), ViewGroup.LayoutParams.WRAP_CONTENT))
        val brightnessLabel = label("BRIGHTNESS", 14f, LABEL)
        brightnessLabel.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        controls.addView(brightnessLabel, spaced(LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)))
        brightnessBar.setPadding(dp(18), dp(14), dp(18), dp(14))
        brightnessBar.max = MAX_BRIGHTNESS - MIN_BRIGHTNESS
        brightnessBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser) brightness.set(progress + MIN_BRIGHTNESS)
            }

            override fun onStartTrackingTouch(bar: SeekBar) {}

            override fun onStopTrackingTouch(bar: SeekBar) {}
        })
        controls.addView(brightnessBar, LayoutParams(dp(220), dp(TOUCH_DP)))
        playerScreen.addView(controls, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun buildVolumeColumn(): LinearLayout {
        val column = LinearLayout(context)
        column.orientation = VERTICAL
        column.gravity = Gravity.CENTER_HORIZONTAL
        val title = label("VOL", 14f, LABEL)
        title.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        title.gravity = Gravity.CENTER
        column.addView(title, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        volumeSlider.max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        volumeSlider.setPadding(0, dp(4), 0, dp(4))
        volumeSlider.contentDescription = "Volume"
        volumeSlider.onChange = { level ->
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, level, 0)
            showVolume(level)
        }
        column.addView(volumeSlider, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        volumeText.setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
        volumeText.gravity = Gravity.CENTER
        column.addView(volumeText, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return column
    }

    private fun render(state: YouTubeState) {
        val player = state.screen == Screen.Player
        resultsScreen.visibility = if (player || accountOpen) GONE else VISIBLE
        playerScreen.visibility = if (player) VISIBLE else GONE
        accountView.visibility = if (!player && accountOpen && state.active) VISIBLE else GONE
        renderBrowse(state)
        renderPlayback(state.playback)
        if (!player || !state.active || state.playback.phase !in CONTROLLABLE) clearPlaybackFeedback()
        if (player && state.active && !floating) startTicker() else stopTicker()
    }

    private fun renderBrowse(state: YouTubeState) {
        val browse = state.browse
        val channel = browse.channelUrl != null
        browseToolbar.visibility = if (channel) GONE else VISIBLE
        channelBackButton.visibility = if (channel) VISIBLE else GONE
        val discovering = !channel && discoveryActive && browse.query == null && browse.feedTitle == "From your channels"
        setText(listTitle, if (discovering) "DISCOVER" else browse.title.uppercase())
        discoveryButton.visibility = if (!channel && browse.query == null && browse.feedTitle == "From your channels" &&
            browse.status == ListStatus.Ready) VISIBLE else GONE
        setText(discoveryButton, if (discovering) "‹ FROM YOUR CHANNELS" else "DISCOVER")
        discoveryButton.contentDescription = if (discovering) "Return to subscribed channels" else "Show related video suggestions"
        val items = if (discovering) state.recommendations.items else browse.items
        if (items !== renderedItems) {
            renderedItems = items
            adapter.submit(items)
            if (items.isEmpty()) grid.setSelection(0)
        }
        val status = if (discovering) state.recommendations.status else browse.status
        val overlay = if (discovering) {
            when (status) {
                ListStatus.Idle, ListStatus.Loading -> "Finding related videos…"
                ListStatus.Empty, ListStatus.Error -> state.recommendations.message
                ListStatus.Ready -> null
            }
        } else {
            when (status) {
                ListStatus.Loading -> "Loading…"
                ListStatus.Idle -> if (browse.items.isEmpty()) "Loading…" else null
                ListStatus.Empty, ListStatus.Error -> browse.message
                ListStatus.Ready -> null
            }
        }
        listOverlay.visibility = if (overlay == null) GONE else VISIBLE
        setText(listMessage, overlay ?: "")
        listRetry.visibility = if (status == ListStatus.Error || status == ListStatus.Empty) VISIBLE else GONE
        val recommendations = state.recommendations
        val more = if (discovering) when {
            recommendations.loadingMore -> "Finding more videos…"
            recommendations.moreFailed -> "Couldn't load more suggestions. Tap to retry."
            recommendations.canLoadMore && recommendations.items.isNotEmpty() && recommendations.message != null -> recommendations.message
            else -> ""
        } else when {
            browse.loadingMore -> "Loading more…"
            browse.moreFailed -> "Couldn't load more videos. Tap to retry."
            else -> ""
        }
        setText(moreStatus, more)
        moreStatus.visibility = if (more.isEmpty()) GONE else VISIBLE
        moreStatus.isClickable = if (discovering) {
            recommendations.moreFailed || (recommendations.canLoadMore && recommendations.message != null)
        } else browse.moreFailed
    }

    private fun renderPlayback(playback: PlaybackState) {
        setText(videoTitle, playback.video?.title ?: "")
        val channelVideo = playback.video
        val channelUrl = YouTubeChannelLinks.normalize(channelVideo?.channelUrl)
        channelButton.visibility = if (channelUrl == null) GONE else VISIBLE
        channelButton.contentDescription = "View ${channelVideo?.channel ?: "channel"} videos"
        setText(channelInitial, channelVideo?.channel?.trim()?.take(1)?.uppercase() ?: "?")
        val avatar = if (channelUrl != null) YouTubeChannelLinks.avatar(channelVideo?.channelAvatarUrl) else null
        channelAvatar.visibility = if (avatar != null) VISIBLE else GONE
        if (avatar != renderedChannelAvatarUrl) {
            renderedChannelAvatarUrl = avatar
            if (avatar != null) loader.bind(channelAvatar, avatar)
            else {
                channelAvatar.setImageDrawable(null)
                channelAvatar.tag = null
            }
        }
        setText(qualityButton, if (playback.live) "LIVE" else "${if (playback.activeHeight > 0) playback.activeHeight else playback.maxHeight}p ▾")
        qualityButton.isEnabled = !playback.live
        videoFrame.aspect = playback.videoAspect
        val overlay = when (playback.phase) {
            PlaybackPhase.Resolving -> playback.message ?: "Loading video…"
            PlaybackPhase.Buffering -> "Buffering…"
            PlaybackPhase.Error -> playback.message ?: "Playback failed."
            PlaybackPhase.Ended -> "Finished"
            else -> null
        }
        playerOverlay.visibility = if (overlay == null) GONE else VISIBLE
        setText(playerMessage, overlay ?: "")
        playerRetry.visibility = if (playback.phase == PlaybackPhase.Error) VISIBLE else GONE
        playerOverlay.setBackgroundColor(if (playback.phase == PlaybackPhase.Buffering) Color.TRANSPARENT else Color.argb(150, 0, 0, 0))
        setText(
            playButton,
            when (playback.phase) {
                PlaybackPhase.Paused -> "PLAY"
                PlaybackPhase.Ended -> "REPLAY"
                else -> "PAUSE"
            },
        )
        playButton.isEnabled = playback.phase in CONTROLLABLE
        captionsButton.isEnabled = playback.captionsAvailable && playback.phase in CONTROLLABLE
        captionsButton.isActivated = captionsButton.isEnabled && playback.captionsEnabled
        captionsButton.setTextColor(if (captionsButton.isActivated) PRIMARY else MUTE)
        captionsButton.contentDescription = when {
            !captionsButton.isEnabled -> "Captions unavailable"
            captionsButton.isActivated -> "Captions on"
            else -> "Captions off"
        }
        val captionText = playback.captionText.takeIf {
            playback.captionsEnabled && playback.phase in CAPTION_PHASES && it.isNotEmpty()
        } ?: ""
        setText(captionsView, captionText)
        captionsView.visibility = if (captionText.isEmpty()) GONE else VISIBLE
        val durationSeconds = (playback.durationMs / 1000).toInt()
        seekBar.isEnabled = !playback.live && durationSeconds > 0 && playback.phase in CONTROLLABLE
        if (seekBar.max != durationSeconds.coerceAtLeast(1)) seekBar.max = durationSeconds.coerceAtLeast(1)
        seekBar.secondaryProgress = (playback.bufferedMs / 1000).toInt()
        if (!seeking) {
            seekBar.progress = (playback.positionMs / 1000).toInt()
            setText(positionText, YouTubeFormat.clock(playback.positionMs))
        }
        setText(durationText, if (playback.live) "LIVE" else YouTubeFormat.clock(playback.durationMs))
    }

    private fun onPlaybackToggle() {
        val state = session.state
        if (!state.active || state.screen != Screen.Player || !session.hasEngine || state.playback.phase !in CONTROLLABLE) return
        session.togglePlay()
        val playing = session.playRequested
        playbackFeedback.setImageResource(if (playing) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause)
        playbackFeedback.setColorFilter(PRIMARY)
        playbackFeedback.contentDescription = if (playing) "Playing" else "Paused"
        handler.removeCallbacks(hidePlaybackFeedback)
        playbackFeedback.visibility = VISIBLE
        handler.postDelayed(hidePlaybackFeedback, FEEDBACK_MS)
    }

    private fun clearPlaybackFeedback() {
        handler.removeCallbacks(hidePlaybackFeedback)
        playbackFeedback.visibility = GONE
    }

    private fun chooseQuality() {
        val current = session.state.playback.maxHeight
        val choices = YouTubeStreamSelector.QUALITY_CHOICES
        val labels = choices.map { "${it}p" + if (it == YouTubeStreamSelector.DEFAULT_MAX_HEIGHT) " (recommended)" else "" }.toTypedArray()
        AlertDialog.Builder(context)
            .setTitle("Maximum video quality")
            .setSingleChoiceItems(labels, choices.indexOf(current).coerceAtLeast(0)) { dialog, which ->
                dialog.dismiss()
                session.setMaxHeight(choices[which])
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    fun setVoiceSearchStatus(status: String?, listening: Boolean = false) {
        voiceStatus.visibility = if (status.isNullOrBlank()) GONE else VISIBLE
        voiceStatus.text = status.orEmpty()
        searchMic.setImageResource(if (listening) R.drawable.ic_recording_dot else R.drawable.ic_mic)
        searchMic.contentDescription = if (listening) "Stop voice search" else "Search YouTube by voice"
        searchMic.isActivated = !status.isNullOrBlank()
    }

    fun acceptVoiceSearchResult(query: String) {
        val recognized = YouTubeVoiceSearch.bestMatch(listOf(query)) ?: return
        if (!session.state.active) return
        searchField.setText(recognized)
        searchField.setSelection(recognized.length)
        submitSearch()
    }

    private fun submitSearch() {
        hideKeyboard()
        val query = searchField.text?.toString()?.trim().orEmpty()
        if (query.isEmpty()) returnToHome() else {
            discoveryActive = false
            session.search(query)
        }
    }

    private fun returnToHome() {
        onVoiceSearchCancelled()
        hideKeyboard()
        val connected = accountController.hasAccount()
        val reload = YouTubeHomeNavigation.shouldReload(previousAccountState, connected, session.state.browse)
        searchField.setText("")
        discoveryActive = false
        accountOpen = false
        accountView.close()
        previousAccountState = connected
        if (reload) session.showTrending()
        render(session.state)
    }

    private fun refreshVolume() {
        if (volumeSlider.dragging) return
        val level = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
        volumeSlider.progress = level
        showVolume(level)
    }

    private fun showVolume(level: Int) {
        setText(volumeText, "${level * 100 / volumeSlider.max}%")
    }

    private fun refreshBrightness() {
        brightnessBar.progress = (brightness.percent().coerceIn(MIN_BRIGHTNESS, MAX_BRIGHTNESS)) - MIN_BRIGHTNESS
    }

    private fun startTicker() {
        if (ticking) return
        ticking = true
        refreshVolume()
        handler.postDelayed(ticker, TICK_MS)
    }

    private fun stopTicker() {
        ticking = false
        handler.removeCallbacks(ticker)
    }

    private fun hideKeyboard() {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(searchField.windowToken, 0)
        searchField.clearFocus()
    }

    private fun setText(view: TextView, text: String) {
        if (view.text.toString() != text) view.text = text
    }

    private fun label(text: String, sizeSp: Float, color: Int): TextView {
        val view = TextView(context)
        view.text = text
        view.textSize = sizeSp
        view.setTextColor(color)
        return view
    }

    private fun button(text: String): TextView {
        val view = label(text, 16f, PRIMARY)
        view.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        view.letterSpacing = 0.08f
        view.gravity = Gravity.CENTER
        view.isClickable = true
        view.isFocusable = true
        view.maxLines = 1
        val pressed = outline(PRESSED, PRESSED)
        val normal = outline(DIVIDER, FIELD)
        val states = StateListDrawable()
        states.addState(intArrayOf(android.R.attr.state_pressed), pressed)
        states.addState(intArrayOf(), normal)
        view.background = states
        return view
    }

    private fun outline(stroke: Int, fill: Int): GradientDrawable {
        val drawable = GradientDrawable()
        drawable.setColor(fill)
        drawable.setStroke(dp(1), stroke)
        drawable.cornerRadius = dp(4).toFloat()
        return drawable
    }

    private fun spaced(lp: LayoutParams): LayoutParams {
        lp.leftMargin = dp(10)
        return lp
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

    private inner class VideoAdapter : BaseAdapter() {
        private var items: List<VideoSummary> = emptyList()

        fun submit(next: List<VideoSummary>) {
            items = next
            notifyDataSetChanged()
        }

        fun itemAt(position: Int): VideoSummary? = items.getOrNull(position)

        override fun getCount(): Int = items.size

        override fun getItem(position: Int): Any = items[position]

        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val card = convertView as? VideoCard ?: VideoCard()
            card.bind(items[position])
            return card
        }
    }

    private inner class VideoCard : LinearLayout(context) {
        private val thumb = RatioImageView(context)
        private val badge = label("", 13f, PRIMARY)
        private val title = label("", 16f, PRIMARY)
        private val meta = label("", 13f, MUTE)

        init {
            orientation = VERTICAL
            val frame = FrameLayout(context)
            thumb.scaleType = ImageView.ScaleType.CENTER_CROP
            thumb.setBackgroundColor(FIELD)
            frame.addView(thumb, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            badge.setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
            badge.setBackgroundColor(Color.argb(200, 0, 0, 0))
            badge.setPadding(dp(6), dp(2), dp(6), dp(2))
            val badgeLp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.END or Gravity.BOTTOM)
            badgeLp.setMargins(0, 0, dp(6), dp(6))
            frame.addView(badge, badgeLp)
            addView(frame, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            title.maxLines = 2
            title.ellipsize = TextUtils.TruncateAt.END
            title.setTypeface(Typeface.DEFAULT_BOLD, Typeface.NORMAL)
            title.setLines(2)
            val titleLp = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            titleLp.topMargin = dp(6)
            addView(title, titleLp)
            meta.maxLines = 2
            meta.ellipsize = TextUtils.TruncateAt.END
            addView(meta, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        fun bind(video: VideoSummary) {
            setText(title, video.title)
            setText(meta, YouTubeFormat.previewMeta(video))
            val badgeText = if (video.live) "LIVE" else YouTubeFormat.duration(video.durationSeconds)
            setText(badge, badgeText)
            badge.visibility = if (badgeText.isEmpty()) GONE else VISIBLE
            loader.bind(thumb, video.thumbnailUrl)
        }
    }

    companion object {
        const val PREFS: String = "youtube"
        const val KEY_MAX_HEIGHT: String = "max_height"
        private const val TICK_MS = 500L
        private const val FEEDBACK_MS = 800L
        private const val TOUCH_DP = 56
        private const val COLUMN_DP = 280
        private const val THUMB_WIDTH_DP = 300
        private const val PREFETCH_ITEMS = 6
        private const val VOLUME_COLUMN_DP = 96
        const val MIN_BRIGHTNESS: Int = 5
        const val MAX_BRIGHTNESS: Int = 100
        private val CONTROLLABLE = setOf(PlaybackPhase.Buffering, PlaybackPhase.Playing, PlaybackPhase.Paused, PlaybackPhase.Ended)
        private val CAPTION_PHASES = setOf(PlaybackPhase.Playing, PlaybackPhase.Paused)
        private val BACKGROUND: Int = Color.BLACK
        private val PRIMARY: Int = Color.WHITE
        private val LABEL: Int = Color.rgb(180, 180, 180)
        private val MUTE: Int = Color.rgb(140, 140, 140)
        private val CAPTIONS_ACTIVE: Int = Color.rgb(70, 200, 110)
        private val DIVIDER: Int = Color.rgb(48, 48, 48)
        private val FIELD: Int = Color.rgb(20, 20, 20)
        private val PRESSED: Int = Color.rgb(64, 64, 64)
    }
}

internal interface BrightnessControl {
    fun percent(): Int

    fun set(percent: Int)
}

internal class AspectFrame(context: Context) : FrameLayout(context) {
    var aspect: Float = 16f / 9f
        set(value) {
            val sane = if (value.isFinite() && value > 0.2f && value < 5f) value else 16f / 9f
            if (sane != field) {
                field = sane
                requestLayout()
            }
        }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val maxWidth = MeasureSpec.getSize(widthMeasureSpec)
        val maxHeight = MeasureSpec.getSize(heightMeasureSpec)
        if (maxWidth <= 0 || maxHeight <= 0) {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec)
            return
        }
        var width = maxWidth
        var height = (width / aspect).toInt()
        if (height > maxHeight) {
            height = maxHeight
            width = (height * aspect).toInt()
        }
        super.onMeasure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    }
}

internal class RatioImageView(context: Context) : ImageView(context) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        setMeasuredDimension(width, width * 9 / 16)
    }
}
