// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.view.MotionEvent
import android.view.View
import java.util.Locale

internal object ArcadePalette {
    val PLAYFIELD: Int = Color.rgb(10, 10, 24)
    val BORDER: Int = Color.rgb(48, 48, 48)
    val PRIMARY: Int = Color.WHITE
    val MUTE: Int = Color.rgb(140, 140, 140)
    val CAMERA_HAND: Int = Color.rgb(0, 230, 120)
    val TOUCH_HAND: Int = Color.rgb(255, 200, 0)
    val LOST_HAND: Int = Color.rgb(90, 90, 90)
    val PREVIEW_REGION: Int = Color.rgb(255, 200, 0)
    val FAILURE: Int = Color.rgb(200, 40, 40)
    val OVERLAY: Int = Color.argb(190, 0, 0, 0)
    val TRACE_LOST: Int = Color.argb(110, 200, 40, 40)
    val BRICK_ROWS: IntArray = intArrayOf(
        Color.rgb(200, 72, 72),
        Color.rgb(198, 108, 58),
        Color.rgb(180, 122, 48),
        Color.rgb(162, 162, 42),
        Color.rgb(72, 160, 72),
        Color.rgb(66, 72, 200),
    )
}

internal object PlaygroundGeometry {
    fun handColor(source: HandSource): Int = when (source) {
        HandSource.Camera -> ArcadePalette.CAMERA_HAND
        HandSource.Touch -> ArcadePalette.TOUCH_HAND
        HandSource.Lost -> ArcadePalette.LOST_HAND
    }

    fun banner(game: BreakoutGame, availability: InputAvailability, face: Boolean = false): String? = when (game.phase) {
        GamePhase.Serving -> if (availability == InputAvailability.Present) "GET READY" else idleBanner(availability, face)
        GamePhase.Paused -> when (game.pauseReason) {
            InputAvailability.TrackerUnavailable -> "CAMERA UNAVAILABLE - TOUCH THE SCREEN TO PLAY"
            else -> if (face) "FACE LOST - LOOK AT THE SCREEN TO RESUME" else "HAND LOST - RAISE YOUR HAND TO RESUME"
        }
        GamePhase.GameOver -> "GAME OVER  -  SCORE ${game.score}  -  TAP TO PLAY AGAIN"
        GamePhase.Cleared -> "CLEARED!  SCORE ${game.score}  -  TAP TO PLAY AGAIN"
        GamePhase.Playing -> null
    }

    private fun idleBanner(availability: InputAvailability, face: Boolean): String = when {
        availability == InputAvailability.TrackerUnavailable -> "CAMERA UNAVAILABLE - TOUCH THE SCREEN TO PLAY"
        face -> "LOOK AT THE SCREEN TO START"
        else -> "RAISE YOUR HAND TO START"
    }

    fun statusLabel(status: ArcadeStatus, face: Boolean): String = if (!face) {
        status.label
    } else {
        when (status) {
            ArcadeStatus.CameraReady -> "Camera ready - look at the screen"
            ArcadeStatus.Tracking -> "Tracking face"
            ArcadeStatus.TrackingLost -> "Face lost - look at the screen"
            else -> status.label
        }
    }

    fun speedButtonAt(x: Float, y: Float, right: Float, top: Float, buttonWidth: Float, buttonHeight: Float, gap: Float): Int {
        if (y < top || y > top + buttonHeight) return 0
        for (level in BreakoutSpeed.MIN..BreakoutSpeed.MAX) {
            val left = speedButtonLeft(level, right, buttonWidth, gap)
            if (x >= left && x <= left + buttonWidth) return level
        }
        return 0
    }

    fun speedButtonLeft(level: Int, right: Float, buttonWidth: Float, gap: Float): Float =
        right - (BreakoutSpeed.MAX - level + 1) * buttonWidth - (BreakoutSpeed.MAX - level) * gap

    fun wrap(text: String, maxChars: Int): List<String> {
        if (text.length <= maxChars) return listOf(text)
        val lines = ArrayList<String>()
        var line = StringBuilder()
        for (part in text.split("  ")) {
            if (line.isNotEmpty() && line.length + 2 + part.length > maxChars) {
                lines += line.toString()
                line = StringBuilder()
            }
            if (line.isNotEmpty()) line.append("  ")
            line.append(part)
        }
        if (line.isNotEmpty()) lines += line.toString()
        return lines
    }
}

/**
 * Interchangeable experience slot. It runs the Breakout vertical slice from the latest normalized
 * hand position and arcade status. Touch feeds [input] directly and restarts a finished game.
 */
public class PlaygroundView(context: Context) : View(context) {
    public var input: HandPositionInput? = null
    public var preview: ArcadePreview? = null
    public var diagnosticsOverlay: Boolean = false
    public var faceControl: Boolean = false

    private val game = BreakoutGame().also { g -> g.events = { android.util.Log.i(LandmarkFrameSink.LOG_TAG, "game: $it") } }
    private val settings = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var speedGesture = false
    private var speedRight = 0f
    private var speedTop = 0f
    private val trace = GameplayTrace()
    private var gameInput = GameInput(0.5f, InputAvailability.HandLost)
    private var handSource = HandSource.Lost
    private var handConfidence = 0f
    private var statusText = ""
    private var diagnosticsText = ""
    private var failureText: String? = null
    private var info: ArcadeCameraInfo? = null
    private var hudScore = -1
    private var hudLives = -1
    private var hudText = ""
    private var wrappedSource = ""
    private var wrappedLines: List<String> = emptyList()
    private var lastFrameNanos = Long.MIN_VALUE
    private val density = resources.displayMetrics.density
    private val previewSnapshot = PreviewSnapshot()
    private var previewBitmap: Bitmap? = null
    private var previewVisible = false
    private val previewRect = RectF()
    private val previewPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val previewFramePaint = stroke(ArcadePalette.MUTE, 1f)
    private val previewRegionPaint = stroke(ArcadePalette.PREVIEW_REGION, 1f)
    private val previewPointPaint = fill(ArcadePalette.CAMERA_HAND, antiAlias = true)
    private val borderPaint = stroke(ArcadePalette.BORDER, 2f)
    private val brickPaint = fill(Color.WHITE)
    private val paddlePaint = fill(Color.WHITE)
    private val ballPaint = fill(ArcadePalette.PRIMARY)
    private val overlayPaint = fill(ArcadePalette.OVERLAY)
    private val failurePaint = fill(ArcadePalette.FAILURE)
    private val traceLostPaint = fill(ArcadePalette.TRACE_LOST)
    private val traceTargetPaint = stroke(ArcadePalette.TOUCH_HAND, 1.5f)
    private val tracePaddlePaint = stroke(ArcadePalette.CAMERA_HAND, 1.5f)
    private val hudPaint = text(ArcadePalette.PRIMARY, 18f, Typeface.MONOSPACE, bold = true)
    private val statusPaint = text(ArcadePalette.MUTE, 14f, Typeface.DEFAULT_BOLD, bold = false)
    private val bannerPaint = text(ArcadePalette.PRIMARY, 22f, Typeface.DEFAULT_BOLD, bold = true).apply { textAlign = Paint.Align.CENTER }
    private val diagnosticsPaint = text(ArcadePalette.PRIMARY, 11f, Typeface.MONOSPACE, bold = false)
    private val speedPaint = text(ArcadePalette.PRIMARY, 14f, Typeface.MONOSPACE, bold = true).apply { textAlign = Paint.Align.CENTER }
    private val speedSelectedPaint = fill(ArcadePalette.CAMERA_HAND)
    private val speedIdlePaint = stroke(ArcadePalette.MUTE, 1f)
    private val speedLabels = Array(BreakoutSpeed.MAX + 1) { "${it}x" }

    init {
        setBackgroundColor(ArcadePalette.PLAYFIELD)
        isClickable = true
        game.setSpeedLevel(settings?.getInt(SPEED_KEY, BreakoutSpeed.DEFAULT) ?: BreakoutSpeed.DEFAULT)
    }

    public val speedLevel: Int
        get() = game.speedLevel

    public fun selectSpeed(level: Int) {
        game.setSpeedLevel(level)
        settings?.edit()?.putInt(SPEED_KEY, game.speedLevel)?.apply()
        invalidate()
    }

    public fun render(position: HandPosition, status: ArcadeStatus, diagnostics: String) {
        render(position, status, diagnostics, null)
    }

    public fun render(position: HandPosition, status: ArcadeStatus, diagnostics: String, cameraInfo: ArcadeCameraInfo?) {
        val now = System.nanoTime()
        if (lastFrameNanos != Long.MIN_VALUE && now - lastFrameNanos > CLOCK_RESET_NANOS) game.resetClock()
        lastFrameNanos = now
        handSource = position.source
        handConfidence = position.confidence
        statusText = PlaygroundGeometry.statusLabel(status, faceControl)
        diagnosticsText = diagnostics
        info = cameraInfo
        val failed = status == ArcadeStatus.Unavailable || status == ArcadeStatus.PermissionDenied
        failureText = if (failed) status.label + if (diagnostics.isNotEmpty()) "  ($diagnostics)" else "" else null
        gameInput = GameInput.from(position, status, now)
        game.update(now, gameInput)
        trace.record(game.targetX / game.config.width, game.paddleX / game.config.width, gameInput.availability == InputAvailability.Present)
        if (diagnosticsOverlay) refreshPreview()
        invalidate()
    }

    public fun restartGame() {
        game.restart()
    }

    private fun refreshPreview() {
        val source = preview
        if (source == null) {
            previewVisible = false
            return
        }
        if (!source.copyTo(previewSnapshot)) return
        val w = previewSnapshot.width
        val h = previewSnapshot.height
        if (w <= 0 || h <= 0) {
            previewVisible = false
            return
        }
        var bitmap = previewBitmap
        if (bitmap == null || bitmap.width != w || bitmap.height != h) {
            bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            previewBitmap = bitmap
        }
        bitmap.setPixels(previewSnapshot.pixels, 0, w, 0, 0, w, h)
        previewVisible = true
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        val inset = borderPaint.strokeWidth / 2f
        canvas.drawRect(inset, inset, w - inset, h - inset, borderPaint)
        val cfg = game.config
        val hud = 34f * density
        val scale = minOf(w / cfg.width, (h - hud) / cfg.height)
        val ox = (w - cfg.width * scale) / 2f
        val oy = hud + (h - hud - cfg.height * scale) / 2f
        val bw = cfg.brickWidth * scale
        val bh = cfg.brickHeight * scale
        for (row in 0 until cfg.rows) {
            brickPaint.color = ArcadePalette.BRICK_ROWS[row % ArcadePalette.BRICK_ROWS.size]
            val top = oy + game.brickTop(row) * scale
            for (column in 0 until cfg.columns) {
                if (!game.isAlive(row, column)) continue
                val left = ox + game.brickLeft(column) * scale
                canvas.drawRect(left, top, left + bw, top + bh, brickPaint)
            }
        }
        paddlePaint.color = PlaygroundGeometry.handColor(handSource)
        paddlePaint.alpha = if (handSource == HandSource.Camera) (130 + 125 * handConfidence).toInt().coerceIn(0, 255) else 255
        val half = cfg.paddleWidth / 2f
        canvas.drawRect(
            ox + (game.paddleX - half) * scale,
            oy + cfg.paddleTop * scale,
            ox + (game.paddleX + half) * scale,
            oy + (cfg.paddleTop + cfg.paddleHeight) * scale,
            paddlePaint,
        )
        if (game.phase != GamePhase.GameOver) {
            val r = cfg.ballRadius * scale
            val bx = ox + game.ballX * scale
            val by = oy + game.ballY * scale
            canvas.drawRect(bx - r, by - r, bx + r, by + r, ballPaint)
        }
        drawHud(canvas, w, hud)
        PlaygroundGeometry.banner(game, gameInput.availability, faceControl)?.let {
            val baseline = oy + cfg.height * scale * 0.62f
            val half = bannerPaint.measureText(it) / 2f + 16f * density
            canvas.drawRect(w / 2f - half, baseline - bannerPaint.textSize - 8f * density, w / 2f + half, baseline + 12f * density, overlayPaint)
            canvas.drawText(it, w / 2f, baseline, bannerPaint)
        }
        failureText?.let { text ->
            val top = hud
            canvas.drawRect(inset, top, w - inset, top + 22f * density, failurePaint)
            canvas.drawText(text, 12f * density, top + 16f * density, statusPaint.also { it.color = ArcadePalette.PRIMARY })
            statusPaint.color = ArcadePalette.MUTE
        }
        if (diagnosticsOverlay) drawOverlay(canvas, w, hud, oy + cfg.paddleTop * scale - 10f * density)
    }

    private fun drawHud(canvas: Canvas, w: Float, hud: Float) {
        if (game.score != hudScore || game.lives != hudLives) {
            hudScore = game.score
            hudLives = game.lives
            hudText = String.format(Locale.US, "SCORE %04d   LIVES %d", hudScore, hudLives.coerceAtLeast(0))
        }
        val baseline = hud - 10f * density
        canvas.drawText(hudText, 14f * density, baseline, hudPaint)
        val bw = SPEED_BUTTON_WIDTH_DP * density
        val bh = SPEED_BUTTON_HEIGHT_DP * density
        val gap = SPEED_BUTTON_GAP_DP * density
        speedRight = w - 10f * density
        speedTop = (hud - bh) / 2f + 2f * density
        for (level in BreakoutSpeed.MIN..BreakoutSpeed.MAX) {
            val left = PlaygroundGeometry.speedButtonLeft(level, speedRight, bw, gap)
            val selected = level == game.speedLevel
            canvas.drawRect(left, speedTop, left + bw, speedTop + bh, if (selected) speedSelectedPaint else speedIdlePaint)
            speedPaint.color = if (selected) ArcadePalette.PLAYFIELD else ArcadePalette.MUTE
            canvas.drawText(speedLabels[level], left + bw / 2f, speedTop + bh / 2f + speedPaint.textSize / 2.8f, speedPaint)
        }
    }

    private fun drawOverlay(canvas: Canvas, w: Float, hud: Float, traceBottom: Float) {
        if (wrappedSource != diagnosticsText) {
            wrappedSource = diagnosticsText
            wrappedLines = PlaygroundGeometry.wrap(diagnosticsText, OVERLAY_CHARS)
        }
        val lineHeight = diagnosticsPaint.textSize + 3f * density
        val inputLine = String.format(
            Locale.US,
            "%s  input %s  age %d ms  conf %.2f  target %.3f  paddle %.3f  lag %.3f  phase %s  speed %dx  hits %d",
            statusText,
            gameInput.availability,
            gameInput.ageNanos / 1_000_000L,
            handConfidence,
            game.targetX / game.config.width,
            game.paddleX / game.config.width,
            kotlin.math.abs(game.targetX - game.paddleX) / game.config.width,
            game.phase,
            game.speedLevel,
            game.paddleHits,
        )
        val missLine = String.format(
            Locale.US,
            "misses: present %d  hand-lost %d  unavailable %d  (last input age %s)",
            game.misses.count { it.availability == InputAvailability.Present },
            game.misses.count { it.availability == InputAvailability.HandLost },
            game.misses.count { it.availability == InputAvailability.TrackerUnavailable },
            game.misses.lastOrNull()?.let { "${it.inputAgeMs} ms" } ?: "-",
        )
        val lines = wrappedLines.size + 2
        val top = hud + 26f * density
        canvas.drawRect(8f * density, top, w - 8f * density, top + lines * lineHeight + 8f * density, overlayPaint)
        var y = top + lineHeight
        for (line in wrappedLines) {
            canvas.drawText(line, 14f * density, y, diagnosticsPaint)
            y += lineHeight
        }
        canvas.drawText(inputLine, 14f * density, y, diagnosticsPaint)
        y += lineHeight
        canvas.drawText(missLine, 14f * density, y, diagnosticsPaint)
        val previewWidth = PREVIEW_WIDTH_DP * density + 24f * density
        drawTrace(canvas, w - previewWidth, traceBottom)
        drawPreview(canvas, w, traceBottom)
    }

    private fun drawTrace(canvas: Canvas, right: Float, bottom: Float) {
        val traceHeight = TRACE_HEIGHT_DP * density
        val left = 12f * density
        val top = bottom - traceHeight
        canvas.drawRect(left, top, right, top + traceHeight, overlayPaint)
        val n = trace.count
        if (n < 2) return
        val step = (right - left) / (n - 1)
        for (age in 0 until n) {
            val i = trace.index(age)
            val x = right - age * step
            if (!trace.present[i]) canvas.drawRect(x - step / 2f, top, x + step / 2f, top + traceHeight, traceLostPaint)
        }
        for (age in 0 until n - 1) {
            val a = trace.index(age)
            val b = trace.index(age + 1)
            val x1 = right - age * step
            val x2 = right - (age + 1) * step
            canvas.drawLine(x1, top + traceHeight * (1f - trace.target[a]), x2, top + traceHeight * (1f - trace.target[b]), traceTargetPaint)
            canvas.drawLine(x1, top + traceHeight * (1f - trace.paddle[a]), x2, top + traceHeight * (1f - trace.paddle[b]), tracePaddlePaint)
        }
    }

    private fun drawPreview(canvas: Canvas, viewWidth: Float, bottom: Float) {
        val bitmap = previewBitmap
        if (!previewVisible || bitmap == null) return
        val s = previewSnapshot
        val pw = PREVIEW_WIDTH_DP * density
        val ph = pw * s.height / s.width
        val right = viewWidth - 12f * density
        previewRect.set(right - pw, bottom - ph, right, bottom)
        canvas.drawBitmap(bitmap, null, previewRect, previewPaint)
        canvas.drawRect(previewRect, previewFramePaint)
        canvas.drawRect(
            previewRect.left + s.regionLeft * pw,
            previewRect.top + s.regionTop * ph,
            previewRect.left + s.regionRight * pw,
            previewRect.top + s.regionBottom * ph,
            previewRegionPaint,
        )
        if (!s.pointX.isNaN() && !s.pointY.isNaN()) {
            canvas.drawCircle(previewRect.left + s.pointX * pw, previewRect.top + s.pointY * ph, 3f * density, previewPointPaint)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            val level = PlaygroundGeometry.speedButtonAt(
                event.x,
                event.y,
                speedRight,
                speedTop,
                SPEED_BUTTON_WIDTH_DP * density,
                SPEED_BUTTON_HEIGHT_DP * density,
                SPEED_BUTTON_GAP_DP * density,
            )
            if (level != 0) {
                speedGesture = true
                selectSpeed(level)
                return true
            }
        }
        if (speedGesture) {
            if (event.actionMasked == MotionEvent.ACTION_UP) {
                speedGesture = false
                performClick()
            } else if (event.actionMasked == MotionEvent.ACTION_CANCEL) {
                speedGesture = false
            }
            return true
        }
        val target = input ?: return super.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE ->
                target.onTouch(HandMapping.normalize(event.x, width.toFloat()), HandMapping.normalize(event.y, height.toFloat()))
            MotionEvent.ACTION_UP -> {
                target.onTouchUp()
                if (game.phase == GamePhase.GameOver || game.phase == GamePhase.Cleared) game.restart()
                performClick()
            }
            MotionEvent.ACTION_CANCEL -> target.onTouchUp()
        }
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun stroke(color: Int, widthDp: Float): Paint = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = widthDp * density
        this.color = color
    }

    private fun fill(color: Int, antiAlias: Boolean = false): Paint = Paint(if (antiAlias) Paint.ANTI_ALIAS_FLAG else 0).apply {
        style = Paint.Style.FILL
        this.color = color
    }

    private fun text(color: Int, sizeSp: Float, face: Typeface, bold: Boolean): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        textSize = sizeSp * density
        typeface = face
        isFakeBoldText = bold && face == Typeface.MONOSPACE
    }

    private companion object {
        const val PREVIEW_WIDTH_DP = 160f
        const val TRACE_HEIGHT_DP = 56f
        const val OVERLAY_CHARS = 150
        const val CLOCK_RESET_NANOS = 500_000_000L
        const val PREFS = "fitbaus_arcade"
        const val SPEED_KEY = "breakout_speed"
        const val SPEED_BUTTON_WIDTH_DP = 44f
        const val SPEED_BUTTON_HEIGHT_DP = 26f
        const val SPEED_BUTTON_GAP_DP = 6f
    }
}
