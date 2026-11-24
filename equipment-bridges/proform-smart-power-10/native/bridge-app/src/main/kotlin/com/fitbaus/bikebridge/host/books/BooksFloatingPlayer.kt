package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import java.util.Locale

internal data class BooksFloatingBounds(val x: Int, val y: Int, val width: Int, val height: Int) {
    fun constrained(hostWidth: Int, hostHeight: Int, minWidth: Int, minHeight: Int): BooksFloatingBounds {
        val w = width.coerceIn(minOf(minWidth, hostWidth), hostWidth)
        val h = height.coerceIn(minOf(minHeight, hostHeight), hostHeight)
        return BooksFloatingBounds(x.coerceIn(0, hostWidth - w), y.coerceIn(0, hostHeight - h), w, h)
    }
}

internal class BooksFloatingPlayer(
    context: Context,
    private val restore: () -> Unit,
    close: () -> Unit,
    toggle: () -> Unit,
    skip: (Long) -> Unit,
) : LinearLayout(context) {
    private val title = text("", 14f)
    private val body = text("", 22f)
    private val cover = ImageView(context)
    private var displayedCover: Bitmap? = null
    private val timing = text("", 12f)
    private val progress = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal)
    private val play = text("PLAY", 16f)
    private val rewind = text("−30s", 15f)
    private val forward = text("+30s", 15f)
    private var bounds: BooksFloatingBounds? = null
    private var host: FrameLayout? = null
    private val hostLayout = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fit() }

    init {
        orientation = VERTICAL
        isClickable = true
        elevation = dp(12).toFloat()
        setPadding(dp(8), dp(4), dp(8), dp(4))
        background = GradientDrawable().apply {
            setColor(Color.BLACK)
            cornerRadius = dp(6).toFloat()
            setStroke(dp(1), Color.DKGRAY)
        }
        val top = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        title.maxLines = 1
        title.ellipsize = TextUtils.TruncateAt.END
        title.contentDescription = "Drag or tap to restore Books"
        title.setOnClickListener { restore() }
        title.setOnTouchListener(gesture(false))
        top.addView(title, LayoutParams(0, dp(40), 1f))
        val expand = text("⛶", 22f)
        expand.contentDescription = "Restore Books"
        expand.setOnClickListener { restore() }
        top.addView(expand, LayoutParams(dp(44), dp(40)))
        val dismiss = text("×", 26f)
        dismiss.contentDescription = "Close Books floating player"
        dismiss.setOnClickListener { close() }
        top.addView(dismiss, LayoutParams(dp(44), dp(40)))
        addView(top, LayoutParams(MATCH, WRAP))
        body.gravity = Gravity.CENTER
        body.ellipsize = TextUtils.TruncateAt.END
        body.setOnClickListener { restore() }
        cover.scaleType = ImageView.ScaleType.FIT_CENTER
        cover.contentDescription = "Audiobook cover. Tap to restore Books."
        cover.setOnClickListener { restore() }
        cover.visibility = GONE
        val stage = FrameLayout(context)
        stage.addView(cover, FrameLayout.LayoutParams(MATCH, MATCH))
        stage.addView(body, FrameLayout.LayoutParams(MATCH, MATCH))
        addView(stage, LayoutParams(MATCH, 0, 1f))
        timing.setTextColor(Color.LTGRAY)
        addView(timing, LayoutParams(MATCH, dp(18)))
        progress.max = 10000
        addView(progress, LayoutParams(MATCH, dp(8)))
        val controls = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        rewind.setOnClickListener { skip(-30_000) }
        play.setOnClickListener { toggle() }
        forward.setOnClickListener { skip(30_000) }
        for (control in listOf(rewind, play, forward)) controls.addView(control, LayoutParams(0, dp(44), 1f))
        val resize = text("↘", 24f)
        resize.contentDescription = "Drag to resize Books"
        resize.setOnClickListener { restore() }
        resize.setOnTouchListener(gesture(true))
        controls.addView(resize, LayoutParams(dp(44), dp(44)))
        addView(controls, LayoutParams(MATCH, WRAP))
        visibility = GONE
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        host = parent as? FrameLayout
        host?.addOnLayoutChangeListener(hostLayout)
    }

    override fun onDetachedFromWindow() {
        host?.removeOnLayoutChangeListener(hostLayout)
        host = null
        super.onDetachedFromWindow()
    }

    fun show() {
        visibility = VISIBLE
        fit()
    }

    fun clearCover() {
        displayedCover = null
        cover.setImageDrawable(null)
        cover.visibility = GONE
    }

    fun render(state: BooksPlayerState, narration: String?, thumbnail: Bitmap?) {
        title.text = state.item?.title.orEmpty()
        val presentation = BooksFloatingPresentation.resolve(narration != null, thumbnail != null, state.failed)
        if (displayedCover !== thumbnail) {
            displayedCover = thumbnail
            cover.setImageBitmap(thumbnail)
        }
        val showCover = presentation == BooksFloatingPresentation.COVER
        cover.visibility = if (showCover) VISIBLE else GONE
        body.visibility = if (showCover) GONE else VISIBLE
        val display = when (presentation) {
            BooksFloatingPresentation.NARRATION -> narration.orEmpty()
            BooksFloatingPresentation.ERROR -> "Playback failed. Tap to restore."
            BooksFloatingPresentation.COVER -> ""
            BooksFloatingPresentation.FALLBACK -> state.item?.author.orEmpty().ifBlank { "Audiobook" }
        }
        if (body.text.toString() != display) body.text = display
        val duration = state.session?.durationMs ?: 0
        timing.text = clock(state.positionMs) + " / " + clock(duration)
        progress.progress = if (duration > 0) (state.positionMs.coerceIn(0, duration) * 10000 / duration).toInt() else 0
        val ready = state.session != null && !state.failed
        play.isEnabled = ready
        rewind.isEnabled = ready
        forward.isEnabled = ready
        play.text = if (state.wantsPlay && state.positionMs < duration) "PAUSE" else "PLAY"
    }

    private fun fit() {
        val container = host ?: return
        if (container.width <= 0 || container.height <= 0) return
        val initial = bounds ?: BooksFloatingBounds(container.width - dp(360) - dp(12), dp(12), dp(360), dp(220))
        applyBounds(initial)
    }

    private fun applyBounds(next: BooksFloatingBounds) {
        val container = host ?: return
        if (container.width <= 0 || container.height <= 0) return
        val clamped = next.constrained(container.width, container.height, dp(260), dp(170))
        bounds = clamped
        val lp = layoutParams as? FrameLayout.LayoutParams ?: return
        if (lp.width != clamped.width || lp.height != clamped.height ||
            lp.leftMargin != clamped.x || lp.topMargin != clamped.y || lp.gravity != (Gravity.TOP or Gravity.LEFT)) {
            layoutParams = FrameLayout.LayoutParams(clamped.width, clamped.height, Gravity.TOP or Gravity.LEFT).apply {
                leftMargin = clamped.x
                topMargin = clamped.y
            }
        }
        body.textSize = (clamped.width / resources.displayMetrics.density / 16f).coerceIn(16f, 38f)
    }

    private fun gesture(resize: Boolean): View.OnTouchListener = object : View.OnTouchListener {
        private var start: BooksFloatingBounds? = null
        private var downX = 0f
        private var downY = 0f
        private var dragged = false
        private val slop = ViewConfiguration.get(context).scaledTouchSlop

        override fun onTouch(view: View, event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    start = bounds
                    downX = event.rawX
                    downY = event.rawY
                    dragged = false
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val initial = start ?: return true
                    val dx = (event.rawX - downX).toInt()
                    val dy = (event.rawY - downY).toInt()
                    if (kotlin.math.abs(dx) > slop || kotlin.math.abs(dy) > slop) dragged = true
                    if (dragged) {
                        val target = if (resize) initial.copy(
                            width = initial.width + dx,
                            height = initial.height + dy,
                        ) else initial.copy(x = initial.x + dx, y = initial.y + dy)
                        applyBounds(target)
                    }
                    return true
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragged) view.performClick()
                    start = null
                    return true
                }
                MotionEvent.ACTION_CANCEL -> {
                    start = null
                    return true
                }
            }
            return true
        }
    }

    private fun text(value: String, size: Float) = TextView(context).apply {
        text = value
        textSize = size
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
    }

    private fun clock(ms: Long): String {
        val seconds = ms.coerceAtLeast(0) / 1000
        return String.format(Locale.US, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

    private companion object {
        const val MATCH = LayoutParams.MATCH_PARENT
        const val WRAP = LayoutParams.WRAP_CONTENT
    }
}
