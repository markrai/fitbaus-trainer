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

/**
 * BIKETRIS: a falling-block game for the console. Move the falling piece by moving the head left
 * or right (Face tracking, the same mirrored x as Bricks) and rotate it clockwise with one
 * deliberate sideways wave, detected from frame-to-frame luminance motion on the same camera
 * stream. Touch fallback: drag across the board to move, tap ROTATE to rotate. Bike telemetry is
 * never read here and nothing is ever sent to the bike.
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
    private val game = BiketrisGame(seed = System.nanoTime())
    private val session = BiketrisSession(game)

    private var touchX = Float.NaN
    private var dragging = false
    private var rotatePressed = false
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
    private val rotateRect = RectF()
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
    }

    public fun render(position: HandPosition, camera: CameraState, failure: String?, diagnostics: String, cameraInfo: ArcadeCameraInfo?) {
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
        session.update(position, camera, if (dragging) touchX else Float.NaN, wave?.latest(), now)
        if (wave != null) waveRate.update(wave.observations, now)
        updateWindow.record((System.nanoTime() - start) / 1_000_000f)
        invalidate()
    }

    /** Host pause or game switch: stop the clock and forget transient input so nothing stale is replayed. */
    public fun pause() {
        session.pause()
        dragging = false
        touchX = Float.NaN
        rotatePressed = false
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
        val buttonW = minOf(w - pad - panelLeft, 260f * density)
        val buttonH = 96f * density
        rotateRect.set(panelLeft, boardTop + boardHeight - buttonH, panelLeft + buttonW, boardTop + boardHeight)
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
        var y = boardTop + 16f * density + infoPaint.textSize
        infoPaint.color = BiketrisPalette.PRIMARY
        canvas.drawText("HEAD LEFT / RIGHT TO MOVE", left, y, infoPaint)
        y += infoPaint.textSize + 8f * density
        infoPaint.color = if (waveEnabled) BiketrisPalette.PRIMARY else BiketrisPalette.MUTE
        canvas.drawText(if (waveEnabled) "WAVE HAND TO ROTATE" else "WAVE ROTATION OFF", left, y, infoPaint)
        y += infoPaint.textSize + 8f * density
        infoPaint.color = BiketrisPalette.MUTE
        canvas.drawText("OR DRAG / TAP ROTATE", left, y, infoPaint)
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
        if (game.phase == BiketrisPhase.Playing && rotateRect.width() > 40f * density) {
            fill.color = if (rotatePressed) BiketrisPalette.BUTTON_PRESSED else BiketrisPalette.BUTTON
            canvas.drawRect(rotateRect, fill)
            stroke.color = BiketrisPalette.BORDER
            stroke.strokeWidth = 2f * density
            canvas.drawRect(rotateRect, stroke)
            canvas.drawText("ROTATE", rotateRect.centerX(), rotateRect.centerY() + buttonPaint.textSize / 3f, buttonPaint)
        }
    }

    private fun statusText(): String = when {
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
            banner(canvas, "HEAD LEFT / RIGHT TO MOVE", cx, boardTop + boardHeight * 0.18f, 15f)
            if (waveEnabled) banner(canvas, "WAVE HAND TO ROTATE", cx, boardTop + boardHeight * 0.18f + 30f * density, 15f)
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
            Locale.US, "game %s  level %d  lines %d  pieces %d  gravity %.0f ms  lock resets %d  rotations %d (blocked %d)  touch rot %d  seed %d",
            g.phase, g.level, g.lines, g.piecesSpawned, g.gravitySeconds * 1000f, g.lockResets, g.rotations, g.blockedRotations, session.touchRotations, g.seed,
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
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                when {
                    game.phase == BiketrisPhase.GameOver -> restartPressed = restartRect.contains(x, y)
                    rotateRect.contains(x, y) -> rotatePressed = true
                    x >= boardLeft - cell * 2f && x <= boardLeft + boardWidth + cell * 2f -> {
                        dragging = true
                        touchX = boardFraction(x)
                        session.noteTouchIntent()
                    }
                }
            }
            MotionEvent.ACTION_MOVE -> {
                if (dragging) touchX = boardFraction(x)
                if (rotatePressed && !rotateRect.contains(x, y)) rotatePressed = false
                if (restartPressed && !restartRect.contains(x, y)) restartPressed = false
            }
            MotionEvent.ACTION_UP -> {
                if (rotatePressed && rotateRect.contains(x, y)) session.requestTouchRotation()
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
        rotatePressed = false
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
