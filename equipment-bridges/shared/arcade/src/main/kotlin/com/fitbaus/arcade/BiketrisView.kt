// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.view.MotionEvent
import android.view.View
import java.util.Locale
import kotlin.math.floor
import kotlin.math.roundToInt

internal object BiketrisPalette {
    val BACKGROUND: Int = Color.rgb(10, 10, 24)
    val WELL: Int = Color.rgb(16, 16, 34)
    val GRID: Int = Color.rgb(30, 30, 52)
    val BORDER: Int = Color.rgb(90, 90, 120)
    val PRIMARY: Int = Color.WHITE
    val MUTE: Int = Color.rgb(150, 150, 170)
    val GOOD: Int = Color.rgb(110, 236, 130)
    val WARN: Int = Color.rgb(252, 150, 70)
    val OVERLAY: Int = Color.argb(200, 0, 0, 0)
    val BUTTON: Int = Color.rgb(44, 44, 70)
    val BUTTON_PRESSED: Int = Color.rgb(80, 80, 130)
    val SELECTED: Int = Color.rgb(110, 236, 130)
    val PIECES: IntArray = intArrayOf(
        Color.rgb(40, 40, 40),
        Color.rgb(40, 196, 210),
        Color.rgb(232, 196, 48),
        Color.rgb(176, 84, 214),
        Color.rgb(84, 196, 96),
        Color.rgb(226, 78, 72),
        Color.rgb(72, 112, 232),
        Color.rgb(240, 146, 44),
    )

    fun shade(color: Int, factor: Float): Int = Color.rgb(
        (Color.red(color) * factor).toInt().coerceIn(0, 255),
        (Color.green(color) * factor).toInt().coerceIn(0, 255),
        (Color.blue(color) * factor).toInt().coerceIn(0, 255),
    )
}

public enum class BiketrisInputSource { Webcam, Controller, Both }

internal object BiketrisInputSelection {
    const val PREF_KEY = "biketris_input_source"
    fun effective(saved: String?, available: Boolean): BiketrisInputSource = when {
        !available || saved == BiketrisInputSource.Webcam.name -> BiketrisInputSource.Webcam
        saved == BiketrisInputSource.Both.name -> BiketrisInputSource.Both
        else -> BiketrisInputSource.Controller
    }
}

/**
 * BIKETRIS: a falling-block game for the console. Move the falling piece by moving the head left
 * or right (Face tracking, the same mirrored x as Bricks) and rotate it clockwise with one
 * deliberate sideways wave, detected from frame-to-frame luminance motion on the same camera
 * stream. Touch fallback: drag across the board to move. Read-only cadence slows falling
 * pieces when Pedal to Slow Mode is on; the difficulty slider sets their baseline pace.
 * Nothing is ever sent to the bike.
 */
public class BiketrisView(context: Context) : View(context) {
    public var diagnosticsOverlay: Boolean = false
        set(value) {
            field = value
            gestures?.gridRequested = value
        }

    public var gestures: WaveGestureInput? = null
        set(value) {
            field = value
            applyWaveSettings()
            value?.gridRequested = diagnosticsOverlay
        }

    private val density = resources.displayMetrics.density
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var sensitivityIndex = (prefs?.getInt(SENSITIVITY_KEY, DEFAULT_SENSITIVITY) ?: DEFAULT_SENSITIVITY).coerceIn(0, SENSITIVITIES.size - 1)
    private var waveEnabled = prefs?.getBoolean(WAVE_ENABLED_KEY, true) ?: true
    private var waveSensitivity = (prefs?.getInt(WAVE_SENSITIVITY_KEY, WaveConfig.DEFAULT_SENSITIVITY) ?: WaveConfig.DEFAULT_SENSITIVITY)
        .coerceIn(0, WaveConfig.SENSITIVITY_LABELS.size - 1)
    private var cooldownIndex = (prefs?.getInt(WAVE_COOLDOWN_KEY, DEFAULT_COOLDOWN) ?: DEFAULT_COOLDOWN).coerceIn(0, COOLDOWNS_MS.size - 1)
    private var pedalToSlowEnabled = PedalToSlowPreference.enabled(
        prefs.contains(PedalToSlowPreference.KEY),
        prefs.getBoolean(PedalToSlowPreference.KEY, true),
        prefs.getString(PedalToSlowPreference.LEGACY_KEY, null),
    )
    private var difficultyLevel = BiketrisDifficulty.clamp(
        prefs.getInt(BiketrisDifficulty.KEY, BiketrisDifficulty.DEFAULT_LEVEL),
    )
    private val game = BiketrisGame(seed = System.nanoTime())
    private val session = BiketrisSession(game)
    private var selectedInput = prefs?.getString(BiketrisInputSelection.PREF_KEY, null)
    public var controllerAvailable: Boolean = false
        set(value) {
            if (field != value) {
                field = value
                invalidate()
            }
        }

    public val inputSource: BiketrisInputSource
        get() = BiketrisInputSelection.effective(selectedInput, controllerAvailable)

    public var onInputSourceChanged: ((BiketrisInputSource) -> Unit)? = null

    public fun selectInputSource(source: BiketrisInputSource) {
        if (source != BiketrisInputSource.Webcam && !controllerAvailable) return
        val prior = inputSource
        selectedInput = source.name
        prefs?.edit()?.putString(BiketrisInputSelection.PREF_KEY, source.name)?.apply()
        if (prior != inputSource) {
            session.pause()
            dragging = false
            touchX = Float.NaN
            onInputSourceChanged?.invoke(inputSource)
        }
        invalidate()
    }

    private var touchX = Float.NaN
    private var dragging = false
    private var inputGesture = false
    private var cadenceTogglePressed = false
    private var difficultyDragging = false
    private var restartPressed = false
    private var lastRenderNanos = Long.MIN_VALUE
    private var cameraState = CameraState.Off
    private var diagnosticsText = ""
    private var info: ArcadeCameraInfo? = null
    private val frameWindow = DurationWindow(60)
    private val updateWindow = DurationWindow(60)
    private val drawWindow = DurationWindow(60)
    private val waveRate = RateMeter()
    private var hudScore = -1
    private var hudLines = -1
    private var hudLevel = -1
    private var scoreText = ""
    private var linesText = ""
    private var levelText = ""
    private var clearText = ""
    private var clearShownFor = -1f

    private var cell = 0f
    private var boardLeft = 0f
    private var boardTop = 0f
    private var boardWidth = 0f
    private var boardHeight = 0f
    private val selector = CadenceToggleLayout()
    private val difficultyRect = RectF()
    private val webcamRect = RectF()
    private val controllerRect = RectF()
    private val bothRect = RectF()
    private val sourcePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.8f * density
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private var feedbackTop = 0f
    private var shownRpm = Int.MIN_VALUE
    private var shownFallMs = Int.MIN_VALUE
    private var rpmText = ""
    private var fallText = ""
    private val restartRect = RectF()
    private val blockRect = RectF()
    private val checkPath = Path()
    private val heatRect = RectF()
    private var heatCells = ByteArray(0)
    private var heatPixels = IntArray(0)
    private var heatBitmap: Bitmap? = null
    private var heatVersion = -1L
    private val heatPaint = Paint()

    private val fill = Paint()
    private val stroke = Paint().apply { style = Paint.Style.STROKE }
    private val labelPaint = text(BiketrisPalette.MUTE, 13f, Typeface.DEFAULT_BOLD)
    private val valuePaint = text(BiketrisPalette.PRIMARY, 28f, Typeface.MONOSPACE).apply { isFakeBoldText = true }
    private val infoPaint = text(BiketrisPalette.PRIMARY, 15f, Typeface.DEFAULT_BOLD)
    private val bannerPaint = text(BiketrisPalette.PRIMARY, 20f, Typeface.DEFAULT_BOLD).apply { textAlign = Paint.Align.CENTER }
    private val buttonPaint = text(BiketrisPalette.PRIMARY, 22f, Typeface.DEFAULT_BOLD).apply { textAlign = Paint.Align.CENTER }
    private val segmentPaint = text(BiketrisPalette.PRIMARY, 13f, Typeface.DEFAULT_BOLD).apply { textAlign = Paint.Align.CENTER }
    private val feedbackPaint = text(BiketrisPalette.PRIMARY, 16f, Typeface.MONOSPACE).apply { isFakeBoldText = true }
    private val diagPaint = text(BiketrisPalette.PRIMARY, 11f, Typeface.MONOSPACE)
    private val checkPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = BiketrisPalette.GOOD
    }

    init {
        setBackgroundColor(BiketrisPalette.BACKGROUND)
        isClickable = true
        session.mapper.gain = SENSITIVITIES[sensitivityIndex]
        session.cadence.enabled = pedalToSlowEnabled
        game.difficultyLevel = difficultyLevel
    }

    public fun render(
        position: HandPosition,
        camera: CameraState,
        failure: String?,
        connected: Boolean,
        initialized: Boolean,
        rpm: Int?,
        rpmCurrent: Boolean,
        rpmObservedAt: String?,
        diagnostics: String,
        cameraInfo: ArcadeCameraInfo?,
        controller: BiketrisControllerInput? = null,
    ) {
        val now = System.nanoTime()
        if (lastRenderNanos != Long.MIN_VALUE) {
            val gap = now - lastRenderNanos
            frameWindow.record(gap / 1_000_000f)
            if (gap > STALL_NANOS) session.pause(endTouchSession = false)
        }
        lastRenderNanos = now
        cameraState = camera
        info = cameraInfo
        diagnosticsText = if (failure != null && camera != CameraState.Ready) failure else diagnostics
        val start = System.nanoTime()
        val wave = gestures
        val source = inputSource
        session.update(
            position, camera, if (dragging) touchX else Float.NaN,
            if (source != BiketrisInputSource.Controller) wave?.latest() else null,
            now, connected, initialized, rpm, rpmCurrent, rpmObservedAt,
            controller = if (source != BiketrisInputSource.Webcam) controller else null,
            allowWebcamWithController = source == BiketrisInputSource.Both,
        )
        if (wave != null) waveRate.update(wave.observations, now)
        updateWindow.record((System.nanoTime() - start) / 1_000_000f)
        invalidate()
    }

    /** Host pause or game switch: stop the clock and forget transient input so nothing stale is replayed. */
    public fun pause() {
        session.pause()
        dragging = false
        inputGesture = false
        touchX = Float.NaN
        cadenceTogglePressed = false
        difficultyDragging = false
        restartPressed = false
        lastRenderNanos = Long.MIN_VALUE
        waveRate.reset()
    }

    public fun restartGame() {
        session.restart(System.nanoTime())
        clearShownFor = -1f
        invalidate()
    }

    public fun developerOptions(): List<String> = listOf(
        "Head sensitivity: ${SENSITIVITY_LABELS[sensitivityIndex]} (tap to change)",
        if (waveEnabled) "Wave rotation: ON (tap to turn off for comparison)" else "Wave rotation: OFF (tap to turn on)",
        "Wave sensitivity: ${WaveConfig.SENSITIVITY_LABELS[waveSensitivity]} (tap to change)",
        "Wave cooldown: ${COOLDOWNS_MS[cooldownIndex]} ms (tap to change)",
        "Simulate one wave rotation event (dev)",
        "Restart game now",
    )

    public fun selectDeveloperOption(index: Int) {
        when (index) {
            0 -> {
                sensitivityIndex = (sensitivityIndex + 1) % SENSITIVITIES.size
                session.mapper.gain = SENSITIVITIES[sensitivityIndex]
                prefs?.edit()?.putInt(SENSITIVITY_KEY, sensitivityIndex)?.apply()
            }
            1 -> {
                waveEnabled = !waveEnabled
                prefs?.edit()?.putBoolean(WAVE_ENABLED_KEY, waveEnabled)?.apply()
                applyWaveSettings()
            }
            2 -> {
                waveSensitivity = (waveSensitivity + 1) % WaveConfig.SENSITIVITY_LABELS.size
                prefs?.edit()?.putInt(WAVE_SENSITIVITY_KEY, waveSensitivity)?.apply()
                applyWaveSettings()
            }
            3 -> {
                cooldownIndex = (cooldownIndex + 1) % COOLDOWNS_MS.size
                prefs?.edit()?.putInt(WAVE_COOLDOWN_KEY, cooldownIndex)?.apply()
                applyWaveSettings()
            }
            4 -> gestures?.simulate(System.nanoTime())
            5 -> restartGame()
        }
        invalidate()
    }

    private fun togglePedalToSlow() {
        pedalToSlowEnabled = !pedalToSlowEnabled
        session.cadence.enabled = pedalToSlowEnabled
        prefs.edit()
            .putBoolean(PedalToSlowPreference.KEY, pedalToSlowEnabled)
            .remove(PedalToSlowPreference.LEGACY_KEY)
            .apply()
        invalidate()
    }

    private fun selectDifficultyAt(x: Float) {
        val trackLeft = difficultyRect.left + 12f * density
        val trackWidth = (difficultyRect.width() - 24f * density).coerceAtLeast(1f)
        val next = BiketrisDifficulty.fromFraction((x - trackLeft) / trackWidth)
        if (next == difficultyLevel) return
        difficultyLevel = next
        game.difficultyLevel = next
        prefs.edit().putInt(BiketrisDifficulty.KEY, difficultyLevel).apply()
        invalidate()
    }

    private fun applyWaveSettings() {
        val target = gestures ?: return
        target.config = WaveConfig.forSensitivity(waveSensitivity, COOLDOWNS_MS[cooldownIndex] * 1_000_000L)
        target.enabled = waveEnabled
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        layoutBoard(w.toFloat(), h.toFloat())
    }

    private fun layoutBoard(w: Float, h: Float) {
        val pad = 10f * density
        val rows = game.config.visibleRows
        val cols = game.config.columns
        cell = floor(minOf((h - 2f * pad) / rows, w * BOARD_WIDTH_SHARE / cols)).coerceAtLeast(4f)
        boardWidth = cell * cols
        boardHeight = cell * rows
        boardLeft = floor((w - boardWidth) / 2f)
        boardTop = floor((h - boardHeight) / 2f)
        val panelLeft = boardLeft + boardWidth + 24f * density
        val panelWidth = w - pad - panelLeft
        val sourceTop = boardTop + 4f * density
        val sourceSize = 36f * density
        val sourceGap = 6f * density
        val sourceHeight = 28f * density
        webcamRect.set(panelLeft, sourceTop, panelLeft + sourceSize, sourceTop + sourceHeight)
        controllerRect.set(panelLeft + sourceSize + sourceGap, sourceTop,
            panelLeft + 2f * sourceSize + sourceGap, sourceTop + sourceHeight)
        val bothLeft = panelLeft + 2f * (sourceSize + sourceGap)
        bothRect.set(bothLeft, sourceTop, bothLeft + 56f * density, sourceTop + sourceHeight)
        val sliderGap = 10f * density
        val preferredSelectorWidth = segmentPaint.measureText(PedalToSlowPreference.LABEL) + 24f * density
        val selectorWidth = minOf(preferredSelectorWidth, (panelWidth * 0.6f).coerceAtLeast(0f))
        val selectorHeight = 52f * density
        val feedbackHeight = 3f * (feedbackPaint.textSize + 6f * density)
        val selectorTop = boardTop + boardHeight - feedbackHeight - 10f * density - selectorHeight
        selector.set(panelLeft, selectorTop, selectorWidth, selectorHeight)
        val sliderLeft = (panelLeft + selectorWidth + sliderGap).coerceAtMost(panelLeft + panelWidth)
        difficultyRect.set(sliderLeft, selectorTop, panelLeft + panelWidth, selectorTop + selectorHeight)
        feedbackTop = selectorTop + selectorHeight + 10f * density
        val playW = boardWidth * 0.8f
        val playTop = boardTop + boardHeight * 0.56f
        restartRect.set(boardLeft + (boardWidth - playW) / 2f, playTop, boardLeft + (boardWidth + playW) / 2f, playTop + 64f * density)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 0 || height <= 0) return
        if (cell <= 0f) layoutBoard(width.toFloat(), height.toFloat())
        val start = System.nanoTime()
        drawBoard(canvas)
        drawLeftPanel(canvas)
        drawRightPanel(canvas)
        drawBanners(canvas)
        if (diagnosticsOverlay) drawOverlay(canvas)
        drawWindow.record((System.nanoTime() - start) / 1_000_000f)
    }

    private fun drawBoard(canvas: Canvas) {
        val g = game
        fill.color = BiketrisPalette.WELL
        canvas.drawRect(boardLeft, boardTop, boardLeft + boardWidth, boardTop + boardHeight, fill)
        stroke.color = BiketrisPalette.GRID
        stroke.strokeWidth = 1f
        for (c in 1 until g.columns) {
            val x = boardLeft + c * cell
            canvas.drawLine(x, boardTop, x, boardTop + boardHeight, stroke)
        }
        for (r in 1 until g.config.visibleRows) {
            val y = boardTop + r * cell
            canvas.drawLine(boardLeft, y, boardLeft + boardWidth, y, stroke)
        }
        val hidden = g.config.hiddenRows
        for (r in hidden until g.rows) {
            for (c in 0 until g.columns) {
                val color = g.cell(c, r)
                if (color != 0) block(canvas, boardLeft + c * cell, boardTop + (r - hidden) * cell, cell, BiketrisPalette.PIECES[color], 1f)
            }
        }
        if (g.phase == BiketrisPhase.Playing) {
            val cells = g.piece.states[g.rotation]
            val color = BiketrisPalette.PIECES[g.piece.color]
            val ghost = g.ghostY()
            if (ghost != g.pieceY) {
                stroke.color = BiketrisPalette.shade(color, 0.8f)
                stroke.strokeWidth = maxOf(1f, 2f * density)
                for (i in 0 until 4) {
                    val r = ghost + cells[i * 2 + 1] - hidden
                    if (r < 0) continue
                    val x = boardLeft + (g.pieceX + cells[i * 2]) * cell
                    val y = boardTop + r * cell
                    canvas.drawRect(x + 3f, y + 3f, x + cell - 3f, y + cell - 3f, stroke)
                }
            }
            val alpha = if (session.live) 1f else 0.55f
            for (i in 0 until 4) {
                val r = g.pieceY + cells[i * 2 + 1] - hidden
                if (r < 0) continue
                block(canvas, boardLeft + (g.pieceX + cells[i * 2]) * cell, boardTop + r * cell, cell, color, alpha)
            }
        }
        val flash = g.elapsed - g.lastClearAt < CLEAR_FLASH_SECONDS
        stroke.color = if (flash) BiketrisPalette.GOOD else BiketrisPalette.BORDER
        stroke.strokeWidth = (if (flash) 4f else 2f) * density
        canvas.drawRect(boardLeft - stroke.strokeWidth / 2f, boardTop - stroke.strokeWidth / 2f, boardLeft + boardWidth + stroke.strokeWidth / 2f, boardTop + boardHeight + stroke.strokeWidth / 2f, stroke)
    }

    private fun block(canvas: Canvas, x: Float, y: Float, size: Float, color: Int, alpha: Float) {
        val a = (alpha * 255).toInt().coerceIn(0, 255)
        val inset = maxOf(1f, size * 0.06f)
        fill.color = color
        fill.alpha = a
        blockRect.set(x + 1f, y + 1f, x + size - 1f, y + size - 1f)
        canvas.drawRect(blockRect, fill)
        fill.color = BiketrisPalette.shade(color, 1.25f)
        fill.alpha = a
        canvas.drawRect(blockRect.left, blockRect.top, blockRect.right, blockRect.top + inset, fill)
        canvas.drawRect(blockRect.left, blockRect.top, blockRect.left + inset, blockRect.bottom, fill)
        fill.color = BiketrisPalette.shade(color, 0.6f)
        fill.alpha = a
        canvas.drawRect(blockRect.left, blockRect.bottom - inset, blockRect.right, blockRect.bottom, fill)
        canvas.drawRect(blockRect.right - inset, blockRect.top, blockRect.right, blockRect.bottom, fill)
        fill.alpha = 255
    }

    private fun drawLeftPanel(canvas: Canvas) {
        val g = game
        if (g.score != hudScore) {
            hudScore = g.score
            scoreText = String.format(Locale.US, "%06d", hudScore)
        }
        if (g.lines != hudLines) {
            hudLines = g.lines
            linesText = hudLines.toString()
        }
        if (g.level != hudLevel) {
            hudLevel = g.level
            levelText = hudLevel.toString()
        }
        val right = boardLeft - 24f * density
        val left = maxOf(12f * density, right - 220f * density)
        var y = boardTop + 16f * density
        y = stat(canvas, "SCORE", scoreText, left, y)
        y = stat(canvas, "LINES", linesText, left, y)
        y = stat(canvas, "LEVEL", levelText, left, y)
        canvas.drawText("NEXT", left, y + labelPaint.textSize, labelPaint)
        val preview = minOf(cell * 0.9f, (right - left) / 4.5f)
        val boxTop = y + labelPaint.textSize + 8f * density
        val next = g.next
        val cells = next.states[0]
        val offsetX = left + (4 - next.width(0)) * preview / 2f - next.left(0) * preview
        for (i in 0 until 4) {
            block(canvas, offsetX + cells[i * 2] * preview, boxTop + (cells[i * 2 + 1] - next.top(0)) * preview, preview, BiketrisPalette.PIECES[next.color], 1f)
        }
    }

    private fun stat(canvas: Canvas, label: String, value: String, left: Float, top: Float): Float {
        canvas.drawText(label, left, top + labelPaint.textSize, labelPaint)
        canvas.drawText(value, left, top + labelPaint.textSize + valuePaint.textSize + 4f * density, valuePaint)
        return top + labelPaint.textSize + valuePaint.textSize + 22f * density
    }

    private fun drawRightPanel(canvas: Canvas) {
        val left = boardLeft + boardWidth + 24f * density
        drawInputSourceSelector(canvas)
        var y = boardTop + 48f * density + infoPaint.textSize
        val controllerMode = inputSource == BiketrisInputSource.Controller
        val combinedMode = inputSource == BiketrisInputSource.Both
        infoPaint.color = BiketrisPalette.PRIMARY
        canvas.drawText(
            when {
                combinedMode -> "HEAD OR CONTROLLER TO MOVE"
                controllerMode -> "CONTROLLER LEFT / RIGHT"
                else -> "HEAD LEFT / RIGHT TO MOVE"
            },
            left, y, infoPaint,
        )
        y += infoPaint.textSize + 8f * density
        infoPaint.color = BiketrisPalette.PRIMARY
        canvas.drawText(
            when {
                combinedMode -> "CONTROLLER DOWN = FAST DROP"
                controllerMode -> "DOWN TO DROP FASTER"
                waveEnabled -> "WAVE HAND TO ROTATE"
                else -> "WAVE ROTATION OFF"
            },
            left, y, infoPaint,
        )
        y += infoPaint.textSize + 8f * density
        infoPaint.color = BiketrisPalette.MUTE
        canvas.drawText(
            when {
                combinedMode -> if (waveEnabled) "WAVE OR BUTTON TO ROTATE" else "BUTTON TO ROTATE"
                controllerMode -> "ROTATE: MAPPED BUTTON"
                else -> "OR DRAG THE BOARD TO MOVE"
            },
            left, y, infoPaint,
        )
        y += infoPaint.textSize + 20f * density
        infoPaint.color = when {
            session.reading.control == BiketrisControl.Touch || session.touchSession -> BiketrisPalette.WARN
            session.reading.control == BiketrisControl.Face -> BiketrisPalette.GOOD
            else -> BiketrisPalette.MUTE
        }
        canvas.drawText(statusText(), left, y, infoPaint)
        y += infoPaint.textSize + 24f * density
        val now = System.nanoTime()
        val since = session.lastWaveRotationNanos
        if (since != Long.MIN_VALUE && now - since < ROTATE_FLASH_NANOS) {
            bannerPaint.textAlign = Paint.Align.LEFT
            bannerPaint.color = BiketrisPalette.GOOD
            bannerPaint.textSize = 26f * density
            val label = if (session.lastWaveSimulated) "ROTATE (SIM)" else "ROTATE"
            canvas.drawText(label, left, y + bannerPaint.textSize, bannerPaint)
            val cx = left + bannerPaint.measureText(label) + 14f * density
            val s = bannerPaint.textSize
            checkPath.reset()
            checkPath.moveTo(cx, y + s * 0.55f)
            checkPath.lineTo(cx + s * 0.32f, y + s * 0.9f)
            checkPath.lineTo(cx + s * 0.9f, y + s * 0.1f)
            checkPaint.strokeWidth = 4f * density
            canvas.drawPath(checkPath, checkPaint)
            bannerPaint.textAlign = Paint.Align.CENTER
            bannerPaint.color = BiketrisPalette.PRIMARY
            y += s + 16f * density
        }
        if (game.elapsed - game.lastClearAt < CLEAR_TEXT_SECONDS && game.lastClearCount > 0) {
            if (clearShownFor != game.lastClearAt) {
                clearShownFor = game.lastClearAt
                clearText = if (game.lastClearCount == 1) "1 LINE!" else "${game.lastClearCount} LINES!"
            }
            bannerPaint.textAlign = Paint.Align.LEFT
            bannerPaint.color = BiketrisPalette.WARN
            bannerPaint.textSize = 24f * density
            canvas.drawText(clearText, left, y + bannerPaint.textSize, bannerPaint)
            bannerPaint.textAlign = Paint.Align.CENTER
            bannerPaint.color = BiketrisPalette.PRIMARY
        }
        drawSelector(canvas)
        drawDifficultySlider(canvas)
        drawCadenceFeedback(canvas, left)
    }

    private fun drawInputSourceSelector(canvas: Canvas) {
        for (source in BiketrisInputSource.entries) {
            val rect = when (source) {
                BiketrisInputSource.Webcam -> webcamRect
                BiketrisInputSource.Controller -> controllerRect
                BiketrisInputSource.Both -> bothRect
            }
            val selected = inputSource == source
            val available = source == BiketrisInputSource.Webcam || controllerAvailable
            fill.color = if (selected) BiketrisPalette.SELECTED else BiketrisPalette.BUTTON
            canvas.drawRect(rect, fill)
            stroke.color = if (selected) BiketrisPalette.GOOD else BiketrisPalette.BORDER
            stroke.strokeWidth = 1.5f * density
            canvas.drawRect(rect, stroke)
            sourcePaint.color = when {
                selected -> BiketrisPalette.BACKGROUND
                available -> BiketrisPalette.MUTE
                else -> BiketrisPalette.BORDER
            }
            val x = rect.centerX()
            val y = rect.centerY()
            when (source) {
                BiketrisInputSource.Webcam -> drawWebcamIcon(canvas, x, y, 1f)
                BiketrisInputSource.Controller -> drawControllerIcon(canvas, x, y, 1f)
                BiketrisInputSource.Both -> {
                    drawWebcamIcon(canvas, x - 13f * density, y, 0.7f)
                    drawControllerIcon(canvas, x + 13f * density, y, 0.7f)
                }
            }
        }
    }

    private fun drawWebcamIcon(canvas: Canvas, x: Float, y: Float, scale: Float) {
        val d = density * scale
        canvas.drawCircle(x, y - 3f * d, 6.5f * d, sourcePaint)
        canvas.drawCircle(x, y - 3f * d, 2.5f * d, sourcePaint)
        canvas.drawLine(x, y + 4f * d, x, y + 9f * d, sourcePaint)
        canvas.drawLine(x - 8f * d, y + 9f * d, x + 8f * d, y + 9f * d, sourcePaint)
    }

    private fun drawControllerIcon(canvas: Canvas, x: Float, y: Float, scale: Float) {
        val d = density * scale
        canvas.drawRoundRect(x - 12f * d, y - 6f * d, x + 12f * d, y + 7f * d, 5f * d, 5f * d, sourcePaint)
        canvas.drawLine(x - 7f * d, y - 2f * d, x - 7f * d, y + 4f * d, sourcePaint)
        canvas.drawLine(x - 10f * d, y + 1f * d, x - 4f * d, y + 1f * d, sourcePaint)
        canvas.drawCircle(x + 6f * d, y - 1f * d, 1f * d, sourcePaint)
        canvas.drawCircle(x + 9f * d, y + 3f * d, 1f * d, sourcePaint)
    }

    private fun drawSelector(canvas: Canvas) {
        if (!selector.visible) return
        val active = pedalToSlowEnabled
        fill.color = when {
            active -> BiketrisPalette.SELECTED
            cadenceTogglePressed -> BiketrisPalette.BUTTON_PRESSED
            else -> BiketrisPalette.BUTTON
        }
        canvas.drawRect(selector.left, selector.top, selector.left + selector.width, selector.top + selector.height, fill)
        stroke.strokeWidth = 2f * density
        stroke.color = if (active) BiketrisPalette.GOOD else BiketrisPalette.BORDER
        canvas.drawRect(selector.left, selector.top, selector.left + selector.width, selector.top + selector.height, stroke)
        segmentPaint.color = if (active) BiketrisPalette.BACKGROUND else BiketrisPalette.MUTE
        val originalSize = segmentPaint.textSize
        val availableWidth = (selector.width - 8f * density).coerceAtLeast(0f)
        val labelWidth = segmentPaint.measureText(PedalToSlowPreference.LABEL).coerceAtLeast(1f)
        segmentPaint.textSize *= minOf(1f, availableWidth / labelWidth)
        canvas.drawText(
            PedalToSlowPreference.LABEL,
            selector.left + selector.width / 2f,
            selector.top + selector.height / 2f + segmentPaint.textSize / 3f,
            segmentPaint,
        )
        segmentPaint.textSize = originalSize
    }

    private fun drawDifficultySlider(canvas: Canvas) {
        if (difficultyRect.width() <= 24f * density) return
        val trackLeft = difficultyRect.left + 12f * density
        val trackRight = difficultyRect.right - 12f * density
        val trackY = difficultyRect.top + 30f * density
        segmentPaint.color = BiketrisPalette.MUTE
        canvas.drawText("DIFFICULTY $difficultyLevel", difficultyRect.centerX(), difficultyRect.top + 13f * density, segmentPaint)
        stroke.strokeWidth = 3f * density
        stroke.color = BiketrisPalette.BORDER
        canvas.drawLine(trackLeft, trackY, trackRight, trackY, stroke)
        for (level in 1..5) {
            val tickX = trackLeft + (level - 1) * (trackRight - trackLeft) / 4f
            fill.color = if (level <= difficultyLevel) BiketrisPalette.GOOD else BiketrisPalette.MUTE
            canvas.drawCircle(tickX, trackY, 2.5f * density, fill)
            segmentPaint.color = if (level == difficultyLevel) BiketrisPalette.GOOD else BiketrisPalette.MUTE
            canvas.drawText(level.toString(), tickX, difficultyRect.bottom - 2f * density, segmentPaint)
        }
        val selectedX = trackLeft + (difficultyLevel - 1) * (trackRight - trackLeft) / 4f
        fill.color = BiketrisPalette.GOOD
        canvas.drawCircle(selectedX, trackY, 6f * density, fill)
    }

    private fun drawCadenceFeedback(canvas: Canvas, left: Float) {
        val c = session.cadence
        val live = c.live
        val rpm = if (live) c.filteredRpm.roundToInt() else -1
        if (rpm != shownRpm) {
            shownRpm = rpm
            rpmText = if (live) "RPM $rpm" else "RPM UNAVAILABLE"
        }
        val fall = ((game.effectiveGravitySeconds * 1000f) / 10f).roundToInt() * 10
        if (fall != shownFallMs) {
            shownFallMs = fall
            fallText = "FALL $fall ms"
        }
        val line = feedbackPaint.textSize + 6f * density
        var y = feedbackTop + feedbackPaint.textSize
        feedbackPaint.color = if (live) BiketrisPalette.PRIMARY else BiketrisPalette.WARN
        canvas.drawText(rpmText, left, y, feedbackPaint)
        y += line
        feedbackPaint.color = when {
            c.appliedMultiplier > 1.02f -> BiketrisPalette.GOOD
            c.appliedMultiplier < 0.98f -> BiketrisPalette.WARN
            else -> BiketrisPalette.PRIMARY
        }
        canvas.drawText(fallText, left, y, feedbackPaint)
        y += line
        infoPaint.color = BiketrisPalette.MUTE
        canvas.drawText(
            if (!pedalToSlowEnabled) "NORMAL GRAVITY"
            else if (live) PedalToSlowPreference.HINT else "NO RPM - NORMAL SPEED",
            left, y, infoPaint,
        )
    }

    private fun statusText(): String = when {
        inputSource == BiketrisInputSource.Both -> "WEBCAM + CONTROLLER"
        inputSource == BiketrisInputSource.Controller -> "CONTROLLER CONTROL"
        session.reading.control == BiketrisControl.Touch -> "TOUCH CONTROL"
        session.touchSession -> "TOUCH PLAY"
        session.reading.control == BiketrisControl.Face -> "TRACKING HEAD"
        else -> when (cameraState) {
            CameraState.Ready -> "LOOKING FOR FACE"
            CameraState.Unavailable, CameraState.PermissionDenied -> "CAMERA UNAVAILABLE"
            else -> "STARTING CAMERA"
        }
    }

    private fun drawBanners(canvas: Canvas) {
        val cx = boardLeft + boardWidth / 2f
        if (game.phase == BiketrisPhase.GameOver) {
            banner(canvas, "GAME OVER", cx, boardTop + boardHeight * 0.36f, 30f)
            banner(canvas, "SCORE $scoreText", cx, boardTop + boardHeight * 0.46f, 20f)
            fill.color = if (restartPressed) BiketrisPalette.BUTTON_PRESSED else BiketrisPalette.BUTTON
            canvas.drawRect(restartRect, fill)
            stroke.color = BiketrisPalette.GOOD
            stroke.strokeWidth = 2f * density
            canvas.drawRect(restartRect, stroke)
            canvas.drawText("PLAY AGAIN", restartRect.centerX(), restartRect.centerY() + buttonPaint.textSize / 3f, buttonPaint)
            return
        }
        val held = session.message()
        if (held != null) {
            banner(canvas, held, cx, boardTop + boardHeight * 0.45f, if (held.length > 28) 14f else 18f)
        } else if (game.elapsed < INTRO_SECONDS) {
            val controllerMode = inputSource == BiketrisInputSource.Controller
            val combinedMode = inputSource == BiketrisInputSource.Both
            banner(canvas, when {
                combinedMode -> "FACE OR CONTROLLER"
                controllerMode -> "CONTROLLER TO MOVE"
                else -> "HEAD LEFT / RIGHT TO MOVE"
            }, cx, boardTop + boardHeight * 0.18f, 15f)
            if (combinedMode) banner(canvas, "WAVE OR BUTTON = ROTATE",
                cx, boardTop + boardHeight * 0.18f + 30f * density, 15f)
            else if (controllerMode) banner(canvas, "DOWN = DROP   BUTTON = ROTATE",
                cx, boardTop + boardHeight * 0.18f + 30f * density, 15f)
            else if (waveEnabled) banner(canvas, "WAVE HAND TO ROTATE",
                cx, boardTop + boardHeight * 0.18f + 30f * density, 15f)
            banner(canvas, if (pedalToSlowEnabled) PedalToSlowPreference.HINT else "NORMAL GRAVITY",
                cx, boardTop + boardHeight * 0.18f + 60f * density, 15f)
        }
    }

    private fun banner(canvas: Canvas, text: String, cx: Float, baseline: Float, sizeSp: Float) {
        bannerPaint.textSize = sizeSp * density
        bannerPaint.color = BiketrisPalette.PRIMARY
        val half = minOf(bannerPaint.measureText(text) / 2f + 10f * density, width / 2f)
        fill.color = BiketrisPalette.OVERLAY
        canvas.drawRect(cx - half, baseline - bannerPaint.textSize - 6f * density, cx + half, baseline + 8f * density, fill)
        canvas.drawText(text, cx, baseline, bannerPaint)
    }

    private fun drawOverlay(canvas: Canvas) {
        val now = System.nanoTime()
        val r = session.reading
        val g = game
        val w = gestures
        val d = info?.diagnostics
        val lastWave = session.lastWaveRotationNanos
        val lines = ArrayList<String>(6)
        lines += String.format(
            Locale.US, "camera %s  face %.1f Hz  control %s%s  age %d ms  stable %d ms  x %.3f  pos %s  target col %d  piece left %d  hold %s",
            cameraState, d?.processedHz ?: Float.NaN, r.control, if (session.touchSession) " (touch play)" else "", r.ageMs, r.stableMs, r.x,
            if (session.mapper.position.isNaN()) "-" else String.format(Locale.US, "%.2f", session.mapper.position),
            session.targetColumn, g.pieceLeft, session.hold,
        )
        if (w == null) {
            lines += "wave: no gesture input attached"
        } else {
            lines += String.format(
                Locale.US, "wave %s  %.1f Hz  state %s  signal %s  sideways %.1f cells/obs (onset %.1f  release %.1f  baseline %.2f)  dir %+d  travel %.2f/%.2f  region %s  head %+.2f/s  changed %.1f%% (all %.1f%%)",
                if (w.enabled) "on" else "OFF", waveRate.hz, w.state, w.signal, w.evidence, w.onsetLevel, w.releaseLevel, w.baseline,
                w.direction, w.displacement, w.config.minDisplacement,
                if (w.regionX.isNaN()) "-" else String.format(Locale.US, "%.2f,%.2f", w.regionX, w.regionY),
                w.headSpeed, w.mass * 100f, w.globalMass * 100f,
            )
            lines += String.format(
                Locale.US, "detected %d  rejected %d (last %s)  ignored while rearming %d  published %d (refused %d)  consumed %d  discarded %d  rotated %d  blocked %d  simulated %d  last rotation %s",
                w.accepted, w.rejected, w.lastReject, w.suppressed, w.published, w.publishRefused, session.consumedWaves, session.discardedWaves,
                session.waveRotations, session.blockedWaveRotations, w.simulatedEvents,
                if (lastWave == Long.MIN_VALUE) "-" else "${(now - lastWave) / 1_000_000L} ms ago",
            )
            lines += String.format(
                Locale.US, "motion p50 %.2f / p90 %.2f ms  observations %d  skipped %d  head mask x %.2f..%.2f y %.2f..%.2f",
                w.processing.percentile(0.5f), w.processing.percentile(0.9f), w.observations, w.skipped.get(),
                w.maskLeft, w.maskRight, w.maskTop, w.maskBottom,
            )
        }
        lines += String.format(
            Locale.US, "game %s  level %d  difficulty %d  input %s  lines %d  pieces %d  gravity %.0f ms  lock resets %d  rotations %d (blocked %d)  seed %d",
            g.phase, g.level, g.difficultyLevel, inputSource, g.lines, g.piecesSpawned, g.gravitySeconds * 1000f, g.lockResets, g.rotations, g.blockedRotations, g.seed,
        )
        val c = session.cadence
        lines += String.format(
            Locale.US, "cadence %s  %s  raw %s  filtered %.1f rpm  target x%.3f  applied x%.3f  level %.0f ms  fall %.0f ms  progress %.2f  sample age %s  samples %d",
            if (c.enabled) "pedal to slow" else "off", c.status, if (c.rawRpm < 0) "-" else c.rawRpm.toString(), c.filteredRpm, c.targetMultiplier, c.appliedMultiplier,
            g.gravitySeconds * 1000f, g.effectiveGravitySeconds * 1000f, g.fallProgress, if (c.sampleAgeMs < 0) "-" else "${c.sampleAgeMs} ms", c.samples,
        )
        lines += String.format(
            Locale.US, "frame p50 %.0f / p90 %.0f ms  update p50 %.2f / p90 %.2f ms  draw p50 %.1f / p90 %.1f ms  steps %d  cpu %s",
            frameWindow.percentile(0.5f), frameWindow.percentile(0.9f), updateWindow.percentile(0.5f), updateWindow.percentile(0.9f),
            drawWindow.percentile(0.5f), drawWindow.percentile(0.9f), session.lastSteps,
            d?.processCpuPercent?.let { if (it.isNaN()) "-" else String.format(Locale.US, "%.0f%%", it) } ?: "-",
        )
        lines += diagnosticsText
        val lineHeight = diagPaint.textSize + 3f * density
        val left = 6f * density
        val top = 4f * density
        val boxW = minOf(width - 2f * left, lines.maxOf { diagPaint.measureText(it) } + 12f * density)
        fill.color = BiketrisPalette.OVERLAY
        canvas.drawRect(left, top, left + boxW, top + lines.size * lineHeight + 6f * density, fill)
        var y = top + lineHeight
        for (line in lines) {
            canvas.drawText(line, left + 6f * density, y, diagPaint)
            y += lineHeight
        }
        if (w != null) drawHeatmap(canvas, w)
    }

    private fun drawHeatmap(canvas: Canvas, w: WaveGestureInput) {
        val cols = w.gridCols
        val rows = w.gridRows
        if (cols <= 0 || rows <= 0) return
        if (heatCells.size != cols * rows) {
            heatCells = ByteArray(cols * rows)
            heatPixels = IntArray(cols * rows)
            heatBitmap = Bitmap.createBitmap(cols, rows, Bitmap.Config.ARGB_8888)
            heatVersion = -1L
        }
        val bitmap = heatBitmap ?: return
        val version = w.copyGrid(heatCells, heatVersion)
        if (version != heatVersion) {
            heatVersion = version
            for (i in heatCells.indices) heatPixels[i] = HEAT_COLORS[heatCells[i].toInt().coerceIn(0, HEAT_COLORS.size - 1)]
            bitmap.setPixels(heatPixels, 0, cols, 0, 0, cols, rows)
        }
        val scale = HEAT_SCALE_DP * density
        val left = 12f * density
        val bottom = height - 12f * density - diagPaint.textSize * 2f
        heatRect.set(left, bottom - rows * scale, left + cols * scale, bottom)
        canvas.drawBitmap(bitmap, null, heatRect, heatPaint)
        stroke.strokeWidth = maxOf(1f, density)
        stroke.color = BiketrisPalette.MUTE
        canvas.drawRect(heatRect, stroke)
        val hw = heatRect.width()
        val hh = heatRect.height()
        stroke.color = HEAT_MASK_EDGE
        canvas.drawRect(left + w.maskLeft * hw, heatRect.top + w.maskTop * hh, left + w.maskRight * hw, heatRect.top + w.maskBottom * hh, stroke)
        if (!w.regionLeft.isNaN()) {
            stroke.color = BiketrisPalette.GOOD
            canvas.drawRect(left + w.regionLeft * hw, heatRect.top + w.regionTop * hh, left + w.regionRight * hw, heatRect.top + w.regionBottom * hh, stroke)
        }
        if (w.direction != 0 && !w.regionX.isNaN()) {
            val cx = left + w.regionX * hw
            val cy = heatRect.top + w.regionY * hh
            val len = (w.displacement * hw).coerceAtLeast(8f * density) * w.direction
            checkPaint.strokeWidth = 2f * density
            canvas.drawLine(cx, cy, cx + len, cy, checkPaint)
            canvas.drawLine(cx + len, cy, cx + len - 6f * density * w.direction, cy - 5f * density, checkPaint)
            canvas.drawLine(cx + len, cy, cx + len - 6f * density * w.direction, cy + 5f * density, checkPaint)
        }
        canvas.drawText("${w.state}  ${w.signal}  last reject ${w.lastReject}", left, bottom + diagPaint.textSize + 4f * density, diagPaint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val x = event.x
        val y = event.y
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            val selection = when {
                webcamRect.contains(x, y) -> BiketrisInputSource.Webcam
                controllerRect.contains(x, y) -> BiketrisInputSource.Controller
                bothRect.contains(x, y) -> BiketrisInputSource.Both
                else -> null
            }
            if (selection != null) {
                inputGesture = true
                selectInputSource(selection)
                return true
            }
        }
        if (inputGesture) {
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
                inputGesture = false
                if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
            }
            return true
        }
        if (event.actionMasked == MotionEvent.ACTION_DOWN && difficultyRect.contains(x, y)) {
            difficultyDragging = true
            selectDifficultyAt(x)
            return true
        }
        if (difficultyDragging) {
            when (event.actionMasked) {
                MotionEvent.ACTION_MOVE, MotionEvent.ACTION_UP -> selectDifficultyAt(x)
            }
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
                difficultyDragging = false
                if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
            }
            invalidate()
            return true
        }
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val cadenceHit = selector.hit(x, y)
                when {
                    cadenceHit -> cadenceTogglePressed = true
                    game.phase == BiketrisPhase.GameOver -> restartPressed = restartRect.contains(x, y)
                    x >= boardLeft - cell * 2f && x <= boardLeft + boardWidth + cell * 2f -> {
                        dragging = true
                        touchX = boardFraction(x)
                        session.noteTouchIntent()
                    }
                }
            }
            MotionEvent.ACTION_MOVE -> {
                if (dragging) touchX = boardFraction(x)
                if (cadenceTogglePressed && !selector.hit(x, y)) cadenceTogglePressed = false
                if (restartPressed && !restartRect.contains(x, y)) restartPressed = false
            }
            MotionEvent.ACTION_UP -> {
                if (cadenceTogglePressed && selector.hit(x, y)) togglePedalToSlow()
                if (restartPressed && restartRect.contains(x, y) && game.phase == BiketrisPhase.GameOver) {
                    restartGame()
                    session.noteTouchIntent()
                }
                endTouch()
                performClick()
            }
            MotionEvent.ACTION_CANCEL -> endTouch()
        }
        invalidate()
        return true
    }

    private fun endTouch() {
        dragging = false
        touchX = Float.NaN
        cadenceTogglePressed = false
        difficultyDragging = false
        restartPressed = false
    }

    private fun boardFraction(x: Float): Float = if (boardWidth <= 0f) 0.5f else HandMapping.clamp01((x - boardLeft) / boardWidth)

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun text(color: Int, sizeSp: Float, face: Typeface): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        textSize = sizeSp * density
        typeface = face
    }

    private companion object {
        const val PREFS = "fitbaus_arcade"
        const val SENSITIVITY_KEY = "biketris_head_sensitivity"
        const val WAVE_ENABLED_KEY = "biketris_wave_enabled"
        const val WAVE_SENSITIVITY_KEY = "biketris_wave_sensitivity"
        const val WAVE_COOLDOWN_KEY = "biketris_wave_cooldown"
        const val DEFAULT_SENSITIVITY = 1
        const val DEFAULT_COOLDOWN = 1
        const val STALL_NANOS = 500_000_000L
        const val ROTATE_FLASH_NANOS = 700_000_000L
        const val CLEAR_FLASH_SECONDS = 0.25f
        const val CLEAR_TEXT_SECONDS = 1.2f
        const val INTRO_SECONDS = 4f
        const val BOARD_WIDTH_SHARE = 0.42f
        val SENSITIVITIES = floatArrayOf(0.85f, 1f, 1.25f, 1.5f)
        val SENSITIVITY_LABELS = arrayOf("Low", "Medium", "High", "Very high")
        val COOLDOWNS_MS = longArrayOf(500L, 650L, 800L, 1000L)
        const val HEAT_SCALE_DP = 3f
        val HEAT_MASK_EDGE: Int = Color.rgb(80, 170, 255)
        val HEAT_COLORS: IntArray = intArrayOf(
            Color.argb(170, 20, 20, 30),
            Color.argb(220, 150, 150, 160),
            Color.argb(170, 30, 70, 140),
            Color.argb(230, 250, 150, 60),
            Color.argb(240, 110, 236, 130),
        )
    }
}
