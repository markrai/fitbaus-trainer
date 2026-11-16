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
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.KeyEvent
import android.view.SurfaceView
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
import com.fitbaus.bikebridge.host.arcade.ExerciseHud

internal class YouTubeContent(
    context: Context,
    private val prefs: SharedPreferences,
) : LinearLayout(context) {
    val hud: ExerciseHud = ExerciseHud(context)
    private val handler = Handler(Looper.getMainLooper())
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val loader = ThumbnailLoader(dp(THUMB_WIDTH_DP))
    private val surface = SurfaceView(context)
    private val mediaSources by lazy { YouTubeMediaSources() }

    val session: YouTubeSession = YouTubeSession(
        catalogFactory = { NewPipeYouTubeCatalog() },
        runner = ExecutorRunner("fitbaus-youtube"),
        main = MainThread { block -> handler.post { block() } },
        engineFactory = PlayerEngineFactory { listener -> ExoPlayerEngine(context, surface, listener) },
        preparer = MediaPreparer { handle, plan -> mediaSources.prepare(handle, plan) },
        initialMaxHeight = prefs.getInt(KEY_MAX_HEIGHT, YouTubeStreamSelector.DEFAULT_MAX_HEIGHT),
        onMaxHeightChanged = { prefs.edit().putInt(KEY_MAX_HEIGHT, it).apply() },
    )

    private val resultsScreen = LinearLayout(context)
    private val searchField = EditText(context)
    private val listTitle = label("", 14f, MUTE)
    private val grid = GridView(context)
    private val adapter = VideoAdapter()
    private val listOverlay = LinearLayout(context)
    private val listMessage = label("", 18f, PRIMARY)
    private val listRetry = button("RETRY")
    private val moreStatus = label("", 14f, MUTE)

    private val playerScreen = LinearLayout(context)
    private val videoTitle = label("", 18f, PRIMARY)
    private val qualityButton = button("360p")
    private val videoFrame = AspectFrame(context)
    private val playerOverlay = LinearLayout(context)
    private val playerMessage = label("", 18f, PRIMARY)
    private val playerRetry = button("RETRY")
    private val playButton = button("PAUSE")
    private val positionText = label("0:00", 16f, PRIMARY)
    private val durationText = label("0:00", 16f, PRIMARY)
    private val seekBar = SeekBar(context)
    private val volumeBar = SeekBar(context)
    private var seeking = false
    private var renderedItems: List<VideoSummary>? = null
    private var ticking = false

    private val ticker = object : Runnable {
        override fun run() {
            session.tick()
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
        session.listener = { render(it) }
        render(session.state)
    }

    fun start() {
        refreshVolume()
        session.start()
    }

    fun stop() {
        hideKeyboard()
        stopTicker()
        session.stop()
        loader.pause()
    }

    fun destroy() {
        stopTicker()
        session.destroy()
        loader.shutdown()
    }

    private fun buildResults() {
        resultsScreen.orientation = VERTICAL
        val bar = LinearLayout(context)
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
        searchField.setPadding(dp(14), 0, dp(14), 0)
        searchField.setOnEditorActionListener { _, actionId, event ->
            val enter = event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
            if (actionId == EditorInfo.IME_ACTION_SEARCH || enter) {
                submitSearch()
                true
            } else {
                false
            }
        }
        bar.addView(searchField, LayoutParams(0, dp(TOUCH_DP), 1f))
        val search = button("SEARCH")
        search.setOnClickListener { submitSearch() }
        bar.addView(search, spaced(LayoutParams(dp(140), dp(TOUCH_DP))))
        val trending = button("TRENDING")
        trending.setOnClickListener {
            hideKeyboard()
            searchField.setText("")
            session.showTrending()
        }
        bar.addView(trending, spaced(LayoutParams(dp(160), dp(TOUCH_DP))))
        resultsScreen.addView(bar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        listTitle.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        listTitle.maxLines = 1
        listTitle.ellipsize = TextUtils.TruncateAt.END
        val titleLp = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        titleLp.topMargin = dp(10)
        titleLp.bottomMargin = dp(6)
        resultsScreen.addView(listTitle, titleLp)

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
                if (totalItemCount > 0 && firstVisibleItem + visibleItemCount >= totalItemCount - PREFETCH_ITEMS) session.loadMore(false)
            }
        })
        body.addView(grid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        listOverlay.orientation = VERTICAL
        listOverlay.gravity = Gravity.CENTER
        listMessage.gravity = Gravity.CENTER
        listOverlay.addView(listMessage, LayoutParams(dp(720), ViewGroup.LayoutParams.WRAP_CONTENT))
        listRetry.setOnClickListener { session.retry() }
        val retryLp = LayoutParams(dp(180), dp(TOUCH_DP))
        retryLp.topMargin = dp(16)
        listOverlay.addView(listRetry, retryLp)
        body.addView(listOverlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        resultsScreen.addView(body, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        moreStatus.gravity = Gravity.CENTER
        moreStatus.minHeight = dp(40)
        moreStatus.setOnClickListener { session.loadMore(true) }
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
        qualityButton.setOnClickListener { chooseQuality() }
        top.addView(qualityButton, spaced(LayoutParams(dp(150), dp(TOUCH_DP))))
        playerScreen.addView(top, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val area = FrameLayout(context)
        area.setBackgroundColor(Color.BLACK)
        videoFrame.addView(surface, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        videoFrame.setOnClickListener { session.togglePlay() }
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
        val areaLp = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        areaLp.topMargin = dp(8)
        areaLp.bottomMargin = dp(8)
        playerScreen.addView(area, areaLp)

        val controls = LinearLayout(context)
        controls.orientation = HORIZONTAL
        controls.gravity = Gravity.CENTER_VERTICAL
        playButton.setOnClickListener { session.togglePlay() }
        controls.addView(playButton, LayoutParams(dp(140), dp(TOUCH_DP)))
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
        val volumeLabel = label("VOL", 14f, LABEL)
        volumeLabel.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        controls.addView(volumeLabel, spaced(LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)))
        volumeBar.setPadding(dp(18), dp(14), dp(18), dp(14))
        volumeBar.max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        volumeBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser) audio.setStreamVolume(AudioManager.STREAM_MUSIC, progress, 0)
            }

            override fun onStartTrackingTouch(bar: SeekBar) {}

            override fun onStopTrackingTouch(bar: SeekBar) {}
        })
        controls.addView(volumeBar, LayoutParams(dp(220), dp(TOUCH_DP)))
        playerScreen.addView(controls, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun render(state: YouTubeState) {
        val player = state.screen == Screen.Player
        resultsScreen.visibility = if (player) GONE else VISIBLE
        playerScreen.visibility = if (player) VISIBLE else GONE
        renderBrowse(state.browse)
        renderPlayback(state.playback)
        if (player && state.active) startTicker() else stopTicker()
    }

    private fun renderBrowse(browse: BrowseState) {
        setText(listTitle, browse.title.uppercase())
        if (browse.items !== renderedItems) {
            renderedItems = browse.items
            adapter.submit(browse.items)
            if (browse.items.isEmpty()) grid.setSelection(0)
        }
        val overlay = when (browse.status) {
            ListStatus.Loading -> "Loading…"
            ListStatus.Idle -> if (browse.items.isEmpty()) "Loading…" else null
            ListStatus.Empty, ListStatus.Error -> browse.message
            ListStatus.Ready -> null
        }
        listOverlay.visibility = if (overlay == null) GONE else VISIBLE
        setText(listMessage, overlay ?: "")
        listRetry.visibility = if (browse.status == ListStatus.Error || browse.status == ListStatus.Empty) VISIBLE else GONE
        val more = when {
            browse.loadingMore -> "Loading more…"
            browse.moreFailed -> "Couldn't load more videos. Tap to retry."
            else -> ""
        }
        setText(moreStatus, more)
        moreStatus.visibility = if (more.isEmpty()) GONE else VISIBLE
        moreStatus.isClickable = browse.moreFailed
    }

    private fun renderPlayback(playback: PlaybackState) {
        setText(videoTitle, playback.video?.title ?: "")
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

    private fun submitSearch() {
        hideKeyboard()
        session.search(searchField.text?.toString() ?: "")
    }

    private fun refreshVolume() {
        volumeBar.progress = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
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
            meta.maxLines = 1
            meta.ellipsize = TextUtils.TruncateAt.END
            addView(meta, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        fun bind(video: VideoSummary) {
            setText(title, video.title)
            setText(meta, listOfNotNull(video.channel?.takeIf { it.isNotBlank() }, YouTubeFormat.views(video.viewCount).takeIf { it.isNotEmpty() }).joinToString("  ·  "))
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
        private const val TOUCH_DP = 56
        private const val COLUMN_DP = 280
        private const val THUMB_WIDTH_DP = 300
        private const val PREFETCH_ITEMS = 6
        private val CONTROLLABLE = setOf(PlaybackPhase.Buffering, PlaybackPhase.Playing, PlaybackPhase.Paused, PlaybackPhase.Ended)
        private val BACKGROUND: Int = Color.BLACK
        private val PRIMARY: Int = Color.WHITE
        private val LABEL: Int = Color.rgb(180, 180, 180)
        private val MUTE: Int = Color.rgb(140, 140, 140)
        private val DIVIDER: Int = Color.rgb(48, 48, 48)
        private val FIELD: Int = Color.rgb(20, 20, 20)
        private val PRESSED: Int = Color.rgb(64, 64, 64)
    }
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
