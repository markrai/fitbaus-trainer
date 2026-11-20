// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.view.MotionEvent
import android.view.View
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** Readable grey-box 2:1 isometric presentation for [GhoulRunGame]. */
public class GhoulRunView(context: Context) : View(context) {
    public var diagnosticsOverlay: Boolean = false
    public var controllerAvailable: Boolean = false
        set(value) {
            field = value
            invalidate()
        }

    private val density = resources.displayMetrics.density
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var selectedInput = prefs?.getString(GhoulRunInputSelection.PREF_KEY, null)
    private var difficultyIndex = (prefs?.getInt(DIFFICULTY_KEY, 1) ?: 1).coerceIn(0, SPRINT_DELTAS.lastIndex)
    private var seed = System.nanoTime()
    private var game = newGame(seed)
    private var session = GhoulRunSession(game)
    private var lastRenderNanos = Long.MIN_VALUE
    private var cameraRow = 0f
    private var cameraCol = 0f
    private var diagnosticsText = ""

    public val inputSource: GhoulRunInputSource
        get() = GhoulRunInputSelection.effective(selectedInput, controllerAvailable)

    public var onInputSourceChanged: ((GhoulRunInputSource) -> Unit)? = null

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        typeface = Typeface.MONOSPACE
        isFakeBoldText = true
    }
    private val path = Path()
    private val webcamRect = RectF()
    private val controllerRect = RectF()
    private val bothRect = RectF()
    private val difficultyRect = RectF()

    init {
        setBackgroundColor(BACKGROUND)
        isClickable = true
    }

    public fun selectInputSource(source: GhoulRunInputSource) {
        if (source != GhoulRunInputSource.Webcam && !controllerAvailable) return
        val prior = inputSource
        selectedInput = source.name
        prefs?.edit()?.putString(GhoulRunInputSelection.PREF_KEY, source.name)?.apply()
        session.pause()
        if (prior != inputSource) onInputSourceChanged?.invoke(inputSource)
        invalidate()
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
        @Suppress("UNUSED_PARAMETER") cameraInfo: ArcadeCameraInfo?,
        controller: GhoulRunControllerInput? = null,
    ) {
        val now = System.nanoTime()
        if (lastRenderNanos != Long.MIN_VALUE && now - lastRenderNanos > STALL_NANOS) session.pause()
        lastRenderNanos = now
        diagnosticsText = failure ?: diagnostics
        val source = inputSource
        session.update(
            position, camera, connected, initialized, rpm, rpmCurrent, rpmObservedAt, now,
            source = source,
            controllerAvailable = controllerAvailable,
            controller = if (source == GhoulRunInputSource.Webcam) null else controller,
        )
        val hunt = game.ghoul.state == GhoulState.Hunting
        val shift = if (hunt) 0.28f else 0f
        val targetRow = game.riderRow + (game.ghoul.row - game.riderRow) * shift
        val targetCol = game.riderCol + (game.ghoul.col - game.riderCol) * shift
        cameraRow += (targetRow - cameraRow) * 0.12f
        cameraCol += (targetCol - cameraCol) * 0.12f
        invalidate()
    }

    public fun pause() {
        session.pause()
        lastRenderNanos = Long.MIN_VALUE
    }

    public fun restartGame() {
        seed += 1L
        session.restart(seed)
        session.pause()
        invalidate()
    }

    public fun developerOptions(): List<String> = listOf(
        "Sprint difficulty: +${SPRINT_DELTAS[difficultyIndex]} RPM (tap to change)",
        "Input source: ${inputSource.name} (use in-game selector)",
        "Recenter head now (look straight ahead)",
        "Recalibrate pace (25 second warm-up)",
        "Restart maze now",
    )

    public fun selectDeveloperOption(index: Int) {
        when (index) {
            0 -> {
                difficultyIndex = (difficultyIndex + 1) % SPRINT_DELTAS.size
                prefs?.edit()?.putInt(DIFFICULTY_KEY, difficultyIndex)?.apply()
                seed += 1L
                val lockedPace = session.pace
                game = newGame(seed)
                session = GhoulRunSession(game, pace = lockedPace)
            }
            2 -> session.recenter()
            3 -> session.recalibratePace()
            4 -> restartGame()
        }
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 0 || height <= 0) return
        drawSelectors(canvas)
        val hunted = game.ghoul.state == GhoulState.Hunting
        val zoom = if (hunted) 0.80f else 1f
        val tileW = min(width / 13f, (height - TOP_UI * density) / 8f) * zoom
        val tileH = tileW / 2f
        val originX = width / 2f
        val originY = TOP_UI * density + (height - TOP_UI * density) * 0.50f
        drawMaze(canvas, originX, originY, tileW, tileH)
        drawChoice(canvas, originX, originY, tileW, tileH)
        drawEntities(canvas, originX, originY, tileW, tileH)
        drawHud(canvas)
        drawPhase(canvas)
        drawThreat(canvas, originX, originY, tileW, tileH)
        session.message()?.let { banner(canvas, it, height * 0.35f, Color.WHITE) }
        if (diagnosticsOverlay) drawDiagnostics(canvas)
    }

    private fun drawMaze(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float) {
        val tiles = ArrayList<MazeTile>(game.world.tileRows * game.world.tileCols)
        for (row in 0 until game.world.tileRows) for (col in 0 until game.world.tileCols) tiles += MazeTile(row, col)
        tiles.sortBy { it.row + it.col }
        for (tile in tiles) {
            val explored = tile in game.exploredTiles
            val lit = game.lightRadius > 0f && game.tileDistance(tile) <= game.lightRadius
            if (!explored && !lit) continue
            val centre = projectTile(tile.row.toFloat(), tile.col.toFloat(), ox, oy, tw, th)
            if (game.world.isFloorTile(tile)) {
                paint.color = if (lit) FLOOR_LIT else FLOOR_EXPLORED
                diamond(canvas, centre.first, centre.second, tw / 2f, th / 2f, paint)
                drawObjective(canvas, tile, centre, tw, th, lit)
            } else {
                drawWallBlock(canvas, centre.first, centre.second, tw, th, lit)
            }
        }
    }

    private fun drawWallBlock(canvas: Canvas, cx: Float, cy: Float, tw: Float, th: Float, lit: Boolean) {
        val rise = th * 0.55f
        val topColor = if (lit) WALL_TOP else dim(WALL_TOP)
        val leftColor = if (lit) WALL_LEFT else dim(WALL_LEFT)
        val rightColor = if (lit) WALL_RIGHT else dim(WALL_RIGHT)
        paint.color = leftColor
        path.reset()
        path.moveTo(cx - tw / 2f, cy)
        path.lineTo(cx, cy + th / 2f)
        path.lineTo(cx, cy + th / 2f - rise)
        path.lineTo(cx - tw / 2f, cy - rise)
        path.close()
        canvas.drawPath(path, paint)
        paint.color = rightColor
        path.reset()
        path.moveTo(cx + tw / 2f, cy)
        path.lineTo(cx, cy + th / 2f)
        path.lineTo(cx, cy + th / 2f - rise)
        path.lineTo(cx + tw / 2f, cy - rise)
        path.close()
        canvas.drawPath(path, paint)
        paint.color = topColor
        diamond(canvas, cx, cy - rise, tw / 2f, th / 2f, paint)
    }

    private fun drawObjective(
        canvas: Canvas,
        tile: MazeTile,
        centre: Pair<Float, Float>,
        tw: Float,
        th: Float,
        lit: Boolean,
    ) {
        if (tile.row % 2 == 0 || tile.col % 2 == 0) return
        val cell = MazeCell((tile.row - 1) / 2, (tile.col - 1) / 2)
        when {
            cell in game.world.keys && cell !in game.collectedKeys -> {
                paint.color = if (lit) KEY else dim(KEY)
                canvas.drawCircle(centre.first, centre.second - th * 0.18f, tw * 0.08f, paint)
            }
            cell in game.world.shrines -> {
                val ready = (game.shrineCooldowns[cell] ?: 0f) <= 0f
                paint.color = if (ready && lit) SHRINE_READY else SHRINE_DIM
                diamond(canvas, centre.first, centre.second - th * 0.08f, tw * 0.18f, th * 0.18f, paint)
            }
            cell == game.world.exit -> {
                paint.color = if (game.exitOpen) EXIT_OPEN else EXIT_LOCKED
                canvas.drawRect(
                    centre.first - tw * 0.14f,
                    centre.second - th * 0.58f,
                    centre.first + tw * 0.14f,
                    centre.second,
                    paint,
                )
            }
        }
    }

    private fun drawChoice(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float) {
        val junction = game.riderCell.moved(game.heading)
        val choice = game.activeChoice ?: return
        if (!game.world.contains(junction)) return
        paint.color = Color.argb(145, 255, 220, 55)
        for (amount in listOf(0.5f, 1f, 1.5f)) {
            val row = 2f * junction.row + 1f + choice.dr * amount
            val col = 2f * junction.col + 1f + choice.dc * amount
            val p = projectTile(row, col, ox, oy, tw, th)
            diamond(canvas, p.first, p.second, tw * 0.42f, th * 0.42f, paint)
        }
    }

    private fun drawEntities(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float) {
        if (game.ghoul.state != GhoulState.Inactive) {
            val ghoulPoint = projectWorld(game.ghoul.row, game.ghoul.col, ox, oy, tw, th)
            if (ghoulPoint.first in -tw..width + tw && ghoulPoint.second in TOP_UI * density - th..height + th) {
                paint.color = if (game.ghoul.state == GhoulState.Stunned) GHOUL_STUNNED else GHOUL
                canvas.drawRect(
                    ghoulPoint.first - tw * 0.16f,
                    ghoulPoint.second - th * 0.78f,
                    ghoulPoint.first + tw * 0.16f,
                    ghoulPoint.second,
                    paint,
                )
            }
        }
        val rider = projectWorld(game.riderRow, game.riderCol, ox, oy, tw, th)
        paint.color = if (game.invulnerableLeft > 0f) RIDER_INVULNERABLE else RIDER
        path.reset()
        path.moveTo(rider.first, rider.second - th * 0.72f)
        path.lineTo(rider.first - tw * 0.14f, rider.second)
        path.lineTo(rider.first + tw * 0.14f, rider.second)
        path.close()
        canvas.drawPath(path, paint)

        val exitDx = (game.world.exit.col - game.riderCol) - (game.world.exit.row - game.riderRow)
        val exitDy = ((game.world.exit.col - game.riderCol) + (game.world.exit.row - game.riderRow)) * 0.5f
        drawArrow(canvas, rider.first, rider.second - th * 0.9f, exitDx, exitDy, COMPASS, tw * 0.38f)
        game.activeChoice?.let { direction ->
            drawArrow(
                canvas,
                rider.first,
                rider.second - th * 1.20f,
                direction.screenDx.toFloat(),
                (direction.dc + direction.dr) * 0.5f,
                HIGHLIGHT,
                tw * 0.52f,
            )
        }
    }

    private fun drawArrow(canvas: Canvas, x: Float, y: Float, dx: Float, dy: Float, color: Int, length: Float) {
        val magnitude = hypot(dx, dy).coerceAtLeast(0.001f)
        val ux = dx / magnitude
        val uy = dy / magnitude
        val ex = x + ux * length
        val ey = y + uy * length
        stroke.color = color
        stroke.strokeWidth = max(3f, length * 0.14f)
        canvas.drawLine(x, y, ex, ey, stroke)
        paint.color = color
        path.reset()
        path.moveTo(ex, ey)
        path.lineTo(ex - ux * length * 0.28f - uy * length * 0.18f, ey - uy * length * 0.28f + ux * length * 0.18f)
        path.lineTo(ex - ux * length * 0.28f + uy * length * 0.18f, ey - uy * length * 0.28f - ux * length * 0.18f)
        path.close()
        canvas.drawPath(path, paint)
    }

    private fun drawHud(canvas: Canvas) {
        text.textSize = 17f * density
        text.color = Color.WHITE
        canvas.drawText("♥".repeat(game.hearts), 12f * density, TOP_UI * density + 21f * density, text)
        if (game.config.keyCount > 0) {
            canvas.drawText("KEYS ${game.keysFound}/${game.config.keyCount}", 12f * density, TOP_UI * density + 43f * density, text)
        }
        drawSpeedGauge(canvas)
    }

    private fun drawSpeedGauge(canvas: Canvas) {
        val reading = session.cadenceReading
        val left = width * 0.26f
        val right = width * 0.76f
        val top = TOP_UI * density + 9f * density
        val bottom = top + 28f * density
        val baseline = if (reading.baseline.isFinite()) reading.baseline else 70f
        val low = baseline - game.config.baselineCreepDelta
        val high = baseline + game.config.sprintDelta
        val baselineX = left + (right - left) * game.config.baselineCreepDelta /
            (game.config.baselineCreepDelta + game.config.sprintDelta)
        paint.color = GAUGE_CREEP
        canvas.drawRect(left, top, baselineX, bottom, paint)
        paint.color = GAUGE_SPRINT
        canvas.drawRect(baselineX, top, right, bottom, paint)
        stroke.strokeWidth = 3f * density
        stroke.color = Color.WHITE
        canvas.drawLine(baselineX, top - 4f * density, baselineX, bottom + 4f * density, stroke)
        val marker = left + (right - left) * ((reading.filteredRpm - low) / (high - low)).coerceIn(0f, 1f)
        paint.color = Color.WHITE
        path.reset()
        path.moveTo(marker, top - 7f * density)
        path.lineTo(marker - 6f * density, top)
        path.lineTo(marker + 6f * density, top)
        path.close()
        canvas.drawPath(path, paint)
        text.textSize = 11f * density
        text.color = Color.WHITE
        canvas.drawText("CREEP", left, bottom + 15f * density, text)
        text.textAlign = Paint.Align.CENTER
        canvas.drawText("CRUISE", baselineX, bottom + 15f * density, text)
        text.textAlign = Paint.Align.RIGHT
        canvas.drawText("SPRINT  ${reading.filteredRpm.toInt()} RPM", right, bottom + 15f * density, text)
        text.textAlign = Paint.Align.LEFT
    }

    private fun drawPhase(canvas: Canvas) {
        when (game.phase) {
            GhoulPhase.WarmUp -> banner(
                canvas,
                "WARM UP - PEDAL AT YOUR NORMAL PACE  ${ceil(session.cadenceReading.warmupRemaining).toInt()}",
                height * 0.40f,
                Color.WHITE,
            )
            GhoulPhase.Results -> game.results?.let {
                banner(canvas, "ESCAPED  ${it.seconds.toInt()}s  CATCHES ${it.catches}", height * 0.40f, EXIT_OPEN)
            }
            GhoulPhase.Countdown -> banner(
                canvas,
                "NEW MAZE IN ${ceil(game.phaseLeft).toInt().coerceAtLeast(1)}",
                height * 0.40f,
                Color.WHITE,
            )
            GhoulPhase.Playing -> Unit
        }
    }

    private fun drawThreat(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float) {
        val state = game.ghoul.state
        if (state != GhoulState.Hunting && state != GhoulState.Searching) return
        val hunted = state == GhoulState.Hunting
        val pulse = ((sin(System.nanoTime() / 160_000_000.0) + 1.0) * 0.5).toFloat()
        if (hunted) {
            stroke.style = Paint.Style.STROKE
            stroke.strokeWidth = (6f + pulse * 7f) * density
            stroke.color = Color.argb((130 + pulse * 100).toInt(), 255, 35, 35)
            canvas.drawRect(3f * density, 3f * density, width - 3f * density, height - 3f * density, stroke)
        }
        val label = if (hunted) "HUNTED" else "SEARCHING"
        banner(
            canvas,
            "$label  GAP ${String.format(Locale.US, "%.1f", game.pathGap)}",
            TOP_UI * density + 92f * density,
            if (hunted) Color.rgb(255, 75, 60) else Color.rgb(210, 145, 55),
        )
        val p = projectWorld(game.ghoul.row, game.ghoul.col, ox, oy, tw, th)
        if (p.first !in 0f..width.toFloat() || p.second !in TOP_UI * density..height.toFloat()) {
            paint.color = if (hunted) Color.RED else Color.rgb(205, 135, 45)
            canvas.drawCircle(
                p.first.coerceIn(14f * density, width - 14f * density),
                p.second.coerceIn(TOP_UI * density + 14f * density, height - 14f * density),
                9f * density,
                paint,
            )
        }
    }

    private fun drawSelectors(canvas: Canvas) {
        val h = 32f * density
        val y = 6f * density
        val w = 94f * density
        webcamRect.set(8f * density, y, 8f * density + w, y + h)
        controllerRect.set(webcamRect.right + 6f * density, y, webcamRect.right + 6f * density + w, y + h)
        bothRect.set(controllerRect.right + 6f * density, y, controllerRect.right + 6f * density + 70f * density, y + h)
        difficultyRect.set(width - 150f * density, y, width - 8f * density, y + h)
        selector(canvas, webcamRect, "WEBCAM", inputSource == GhoulRunInputSource.Webcam, true)
        selector(canvas, controllerRect, "CONTROLLER", inputSource == GhoulRunInputSource.Controller, controllerAvailable)
        selector(canvas, bothRect, "BOTH", inputSource == GhoulRunInputSource.Both, controllerAvailable)
        selector(canvas, difficultyRect, "+${SPRINT_DELTAS[difficultyIndex]} RPM", true, true)
    }

    private fun selector(canvas: Canvas, rect: RectF, label: String, selected: Boolean, enabled: Boolean) {
        paint.color = when {
            !enabled -> Color.rgb(35, 35, 38)
            selected -> Color.rgb(40, 118, 76)
            else -> Color.rgb(68, 68, 74)
        }
        canvas.drawRect(rect, paint)
        text.textSize = 11f * density
        text.textAlign = Paint.Align.CENTER
        text.color = if (enabled) Color.WHITE else Color.GRAY
        canvas.drawText(label, rect.centerX(), rect.centerY() + text.textSize * 0.35f, text)
        text.textAlign = Paint.Align.LEFT
    }

    private fun drawDiagnostics(canvas: Canvas) {
        val cadence = session.cadenceReading
        val lines = listOf(
            String.format(
                Locale.US,
                "baseline %s filtered %.1f speed %.2f light %.1f noise %.1f",
                if (cadence.baseline.isNaN()) "-" else "%.1f".format(Locale.US, cadence.baseline),
                cadence.filteredRpm,
                game.speed,
                game.lightRadius,
                game.noiseRadius,
            ),
            "lean ${String.format(Locale.US, "%.2f", game.lean)} locked ${game.lockedChoice ?: "-"} brake ${game.brakingForChoice} hold ${session.hold}",
            String.format(
                Locale.US,
                "ghoul %s gap %.2f stun %.1f inv %.1f",
                game.ghoul.state,
                game.pathGap,
                game.ghoul.stunLeft,
                game.invulnerableLeft,
            ),
            diagnosticsText,
        )
        text.textSize = 10f * density
        val lineHeight = 14f * density
        val left = 8f * density
        val top = TOP_UI * density + 124f * density
        paint.color = Color.argb(210, 0, 0, 0)
        canvas.drawRect(left, top, width - 8f * density, top + lines.size * lineHeight + 8f * density, paint)
        text.color = Color.WHITE
        lines.forEachIndexed { index, line ->
            canvas.drawText(line, left + 4f * density, top + (index + 1) * lineHeight, text)
        }
    }

    private fun banner(canvas: Canvas, value: String, y: Float, color: Int) {
        text.textSize = 19f * density
        text.textAlign = Paint.Align.CENTER
        paint.color = Color.argb(220, 0, 0, 0)
        val half = min(width * 0.47f, text.measureText(value) / 2f + 14f * density)
        canvas.drawRect(width / 2f - half, y - 27f * density, width / 2f + half, y + 12f * density, paint)
        text.color = color
        canvas.drawText(value, width / 2f, y, text)
        text.textAlign = Paint.Align.LEFT
    }

    private fun projectWorld(row: Float, col: Float, ox: Float, oy: Float, tw: Float, th: Float): Pair<Float, Float> =
        projectTile(row * 2f + 1f, col * 2f + 1f, ox, oy, tw, th)

    private fun projectTile(row: Float, col: Float, ox: Float, oy: Float, tw: Float, th: Float): Pair<Float, Float> {
        val dr = row - (cameraRow * 2f + 1f)
        val dc = col - (cameraCol * 2f + 1f)
        return ox + (dc - dr) * tw / 2f to oy + (dc + dr) * th / 2f
    }

    private fun diamond(canvas: Canvas, cx: Float, cy: Float, hw: Float, hh: Float, source: Paint) {
        path.reset()
        path.moveTo(cx, cy - hh)
        path.lineTo(cx + hw, cy)
        path.lineTo(cx, cy + hh)
        path.lineTo(cx - hw, cy)
        path.close()
        canvas.drawPath(path, source)
    }

    private fun dim(color: Int): Int = Color.rgb(Color.red(color) / 3, Color.green(color) / 3, Color.blue(color) / 3)

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked != MotionEvent.ACTION_UP) return true
        when {
            webcamRect.contains(event.x, event.y) -> selectInputSource(GhoulRunInputSource.Webcam)
            controllerRect.contains(event.x, event.y) -> selectInputSource(GhoulRunInputSource.Controller)
            bothRect.contains(event.x, event.y) -> selectInputSource(GhoulRunInputSource.Both)
            difficultyRect.contains(event.x, event.y) -> selectDeveloperOption(0)
        }
        performClick()
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun newGame(seed: Long): GhoulRunGame =
        GhoulRunGame(GhoulRunConfig(sprintDelta = SPRINT_DELTAS[difficultyIndex].toFloat()), seed)

    private companion object {
        const val PREFS = "fitbaus_arcade"
        const val DIFFICULTY_KEY = "ghoul_run_sprint_delta"
        const val STALL_NANOS = 500_000_000L
        val SPRINT_DELTAS = intArrayOf(10, 20, 30)
        val BACKGROUND = Color.rgb(7, 8, 12)
        val FLOOR_LIT = Color.rgb(78, 82, 88)
        val FLOOR_EXPLORED = Color.rgb(25, 27, 31)
        val WALL_TOP = Color.rgb(118, 122, 130)
        val WALL_LEFT = Color.rgb(72, 75, 82)
        val WALL_RIGHT = Color.rgb(54, 57, 64)
        val KEY = Color.rgb(250, 210, 65)
        val SHRINE_READY = Color.rgb(70, 225, 230)
        val SHRINE_DIM = Color.rgb(35, 67, 72)
        val EXIT_LOCKED = Color.rgb(115, 45, 48)
        val EXIT_OPEN = Color.rgb(70, 220, 105)
        val HIGHLIGHT = Color.rgb(255, 225, 70)
        val COMPASS = Color.rgb(70, 225, 240)
        val RIDER = Color.rgb(70, 155, 255)
        val RIDER_INVULNERABLE = Color.WHITE
        val GHOUL = Color.rgb(105, 185, 90)
        val GHOUL_STUNNED = Color.rgb(120, 210, 230)
        val GAUGE_CREEP = Color.rgb(60, 105, 165)
        val GAUGE_SPRINT = Color.rgb(205, 82, 52)
        const val TOP_UI = 54f
    }
}
