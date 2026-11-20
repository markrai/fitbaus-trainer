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

/** Grey-box 2:1 isometric presentation for the pure [GhoulRunGame] simulation. */
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
        cameraInfo: ArcadeCameraInfo?,
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
        val pursuer = game.monsters.filter { it.state != MonsterState.Inactive && it.state != MonsterState.Patrol }
            .minByOrNull { hypot(it.row - game.riderRow, it.col - game.riderCol) }
        val chase = game.nearestPursuerGap()?.let { (1f - it / 8f).coerceIn(0f, 1f) } ?: 0f
        val targetRow = game.riderRow + ((pursuer?.row ?: game.riderRow) - game.riderRow) * chase * 0.28f
        val targetCol = game.riderCol + ((pursuer?.col ?: game.riderCol) - game.riderCol) * chase * 0.28f
        cameraRow += (targetRow - cameraRow) * 0.12f
        cameraCol += (targetCol - cameraCol) * 0.12f
        @Suppress("UNUSED_VARIABLE") val cameraDiagnostics = cameraInfo
        invalidate()
    }

    public fun pause() {
        session.pause()
        lastRenderNanos = Long.MIN_VALUE
    }

    public fun restartGame() {
        seed += 1L
        game.restart(seed)
        session.pause()
        invalidate()
    }

    public fun developerOptions(): List<String> = listOf(
        "Sprint difficulty: +${SPRINT_DELTAS[difficultyIndex]} RPM (tap to change)",
        "Input source: ${inputSource.name} (use in-game selector)",
        "Recenter head now (look straight ahead)",
        "Restart maze now",
    )

    public fun selectDeveloperOption(index: Int) {
        when (index) {
            0 -> {
                difficultyIndex = (difficultyIndex + 1) % SPRINT_DELTAS.size
                prefs?.edit()?.putInt(DIFFICULTY_KEY, difficultyIndex)?.apply()
                seed += 1L
                game = newGame(seed)
                session = GhoulRunSession(game)
            }
            2 -> session.recenter()
            3 -> restartGame()
        }
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 0 || height <= 0) return
        drawSelectors(canvas)
        val chase = game.nearestPursuerGap()?.let { (1f - it / 8f).coerceIn(0f, 1f) } ?: 0f
        val tileW = min(width / 8.5f, (height - TOP_UI) / 5.2f) * (1f - chase * 0.22f)
        val tileH = tileW / 2f
        val originX = width / 2f
        val originY = TOP_UI + (height - TOP_UI) * 0.48f
        val cells = ArrayList<MazeCell>(game.config.width * game.config.height)
        for (row in 0 until game.config.height) for (col in 0 until game.config.width) cells += MazeCell(row, col)
        cells.sortBy { it.row + it.col }
        for (cell in cells) drawCell(canvas, cell, originX, originY, tileW, tileH)
        drawJunctionHighlight(canvas, originX, originY, tileW, tileH)
        drawEntities(canvas, originX, originY, tileW, tileH)
        drawHud(canvas)
        drawPhase(canvas)
        session.message()?.let { banner(canvas, it, height * 0.35f, Color.WHITE) }
        if (diagnosticsOverlay) drawDiagnostics(canvas)
    }

    private fun drawCell(canvas: Canvas, cell: MazeCell, ox: Float, oy: Float, tw: Float, th: Float) {
        val centre = project(cell.row.toFloat(), cell.col.toFloat(), ox, oy, tw, th)
        val distance = hypot(cell.row - game.riderRow, cell.col - game.riderCol)
        val visible = game.lightRadius > 0f && distance <= game.lightRadius
        val explored = cell in game.explored
        paint.color = when {
            visible -> FLOOR_LIT
            explored -> FLOOR_EXPLORED
            else -> FLOOR_DARK
        }
        diamond(canvas, centre.first, centre.second, tw / 2f, th / 2f, paint)
        if (!visible && !explored) return
        val wallAlpha = if (visible) 255 else 90
        stroke.strokeWidth = max(2f, tw * 0.10f)
        stroke.color = Color.argb(wallAlpha, 112, 116, 124)
        for (direction in listOf(MazeDirection.North, MazeDirection.West, MazeDirection.East, MazeDirection.South)) {
            if (game.world.isOpen(cell, direction)) continue
            val a: Pair<Float, Float>
            val b: Pair<Float, Float>
            when (direction) {
                MazeDirection.North -> { a = centre.first to centre.second - th / 2f; b = centre.first + tw / 2f to centre.second }
                MazeDirection.East -> { a = centre.first + tw / 2f to centre.second; b = centre.first to centre.second + th / 2f }
                MazeDirection.South -> { a = centre.first to centre.second + th / 2f; b = centre.first - tw / 2f to centre.second }
                MazeDirection.West -> { a = centre.first - tw / 2f to centre.second; b = centre.first to centre.second - th / 2f }
            }
            canvas.drawLine(a.first, a.second - th * 0.22f, b.first, b.second - th * 0.22f, stroke)
            canvas.drawLine(a.first, a.second, a.first, a.second - th * 0.22f, stroke)
            canvas.drawLine(b.first, b.second, b.first, b.second - th * 0.22f, stroke)
        }
        when {
            cell in game.world.keys && cell !in game.collectedKeys -> {
                paint.color = KEY
                canvas.drawCircle(centre.first, centre.second - th * 0.25f, tw * 0.08f, paint)
                stroke.color = KEY; stroke.strokeWidth = tw * 0.035f
                canvas.drawLine(centre.first, centre.second - th * 0.25f, centre.first + tw * 0.14f, centre.second - th * 0.25f, stroke)
            }
            cell in game.world.shrines -> {
                paint.color = if (cell == game.activeShrine && game.shrineProtectionLeft > 0f) SHRINE_ACTIVE else SHRINE
                diamond(canvas, centre.first, centre.second - th * 0.12f, tw * 0.15f, th * 0.15f, paint)
            }
            cell == game.world.exit -> {
                paint.color = if (game.exitOpen) EXIT_OPEN else EXIT_LOCKED
                canvas.drawRect(centre.first - tw * 0.13f, centre.second - th * 0.55f, centre.first + tw * 0.13f, centre.second, paint)
            }
        }
    }

    private fun drawJunctionHighlight(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float) {
        val junction = game.riderCell.moved(game.heading)
        if (!game.world.contains(junction)) return
        val choice = game.lockedChoice ?: game.choiceFor(junction, game.heading, session.lane) ?: return
        val a = project(junction.row.toFloat(), junction.col.toFloat(), ox, oy, tw, th)
        val b = project(junction.row + choice.dr * 0.65f, junction.col + choice.dc * 0.65f, ox, oy, tw, th)
        stroke.color = HIGHLIGHT
        stroke.strokeWidth = max(3f, tw * 0.07f)
        canvas.drawLine(a.first, a.second - th * 0.08f, b.first, b.second - th * 0.08f, stroke)
    }

    private fun drawEntities(canvas: Canvas, ox: Float, oy: Float, tw: Float, th: Float) {
        for (monster in game.monsters) {
            if (monster.state == MonsterState.Inactive) continue
            val p = project(monster.row, monster.col, ox, oy, tw, th)
            if (p.first !in -tw..width + tw || p.second !in TOP_UI - th..height + th) {
                paint.color = monsterColor(monster.kind)
                canvas.drawCircle(p.first.coerceIn(12f, width - 12f), p.second.coerceIn(TOP_UI + 12f, height - 12f), 8f * density, paint)
                continue
            }
            paint.color = monsterColor(monster.kind)
            when (monster.kind) {
                GhoulMonsterKind.Ghoul -> canvas.drawRect(p.first - tw * 0.11f, p.second - th * 0.6f, p.first + tw * 0.11f, p.second, paint)
                GhoulMonsterKind.Hound -> canvas.drawOval(RectF(p.first - tw * 0.16f, p.second - th * 0.36f, p.first + tw * 0.16f, p.second), paint)
                GhoulMonsterKind.Wraith -> diamond(canvas, p.first, p.second - th * 0.3f, tw * 0.12f, th * 0.3f, paint)
            }
            if (monster.lungeLeft > 0f) {
                text.textSize = 12f * density; text.color = HIGHLIGHT
                canvas.drawText("${monster.lungeLane.name.uppercase(Locale.US)}!", p.first, p.second - th * 0.8f, text)
            }
        }
        val rider = project(game.riderRow, game.riderCol, ox, oy, tw, th)
        val laneOffset = (session.lane.ordinal - 1) * tw * 0.12f
        paint.color = if (game.invulnerableLeft > 0f) RIDER_INVULNERABLE else RIDER
        path.reset()
        path.moveTo(rider.first + laneOffset, rider.second - th * 0.65f)
        path.lineTo(rider.first + laneOffset - tw * 0.12f, rider.second)
        path.lineTo(rider.first + laneOffset + tw * 0.12f, rider.second)
        path.close()
        canvas.drawPath(path, paint)
    }

    private fun drawHud(canvas: Canvas) {
        text.textSize = 17f * density
        text.color = Color.WHITE
        canvas.drawText("${"♥".repeat(game.hearts)}", 12f * density, TOP_UI + 18f * density, text)
        canvas.drawText("KEYS ${game.keysFound}/${game.config.keyCount}", 12f * density, TOP_UI + 39f * density, text)
        canvas.drawText("LAMP ${(game.lampLevel * 100f).toInt()}%", 12f * density, TOP_UI + 60f * density, text)
        game.nearestPursuerGap()?.let {
            val meterLeft = width - 190f * density
            val meterTop = TOP_UI + 10f * density
            paint.color = Color.rgb(42, 42, 48)
            canvas.drawRect(meterLeft, meterTop, width - 12f * density, meterTop + 16f * density, paint)
            paint.color = if (it < 2f) Color.RED else Color.rgb(230, 150, 50)
            val fraction = (1f - it / 10f).coerceIn(0f, 1f)
            canvas.drawRect(meterLeft, meterTop, meterLeft + (width - 12f * density - meterLeft) * fraction, meterTop + 16f * density, paint)
            text.textSize = 11f * density
            canvas.drawText(String.format(Locale.US, "PURSUER %.1f", it), meterLeft, meterTop + 31f * density, text)
        }
    }

    private fun drawPhase(canvas: Canvas) {
        when (game.phase) {
            GhoulPhase.BreakFree -> banner(canvas, "BREAK FREE! +${String.format(Locale.US, "%.1f", game.config.breakFreeSeconds - game.breakFreeProgress)}s ABOVE BASELINE", height * 0.40f, Color.rgb(255, 100, 80))
            GhoulPhase.Results -> game.results?.let { banner(canvas, "ESCAPED  ${it.seconds.toInt()}s  CATCHES ${it.catches}  KEYS ${it.keys}", height * 0.40f, Color.rgb(120, 255, 150)) }
            GhoulPhase.Countdown -> banner(canvas, "NEW MAZE IN ${ceil(game.phaseLeft).toInt().coerceAtLeast(1)}", height * 0.40f, Color.WHITE)
            GhoulPhase.Playing -> Unit
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
        paint.color = when { !enabled -> Color.rgb(35, 35, 38); selected -> Color.rgb(40, 118, 76); else -> Color.rgb(68, 68, 74) }
        canvas.drawRect(rect, paint)
        text.textSize = 11f * density
        text.textAlign = Paint.Align.CENTER
        text.color = if (enabled) Color.WHITE else Color.GRAY
        canvas.drawText(label, rect.centerX(), rect.centerY() + text.textSize * 0.35f, text)
        text.textAlign = Paint.Align.LEFT
    }

    private fun drawDiagnostics(canvas: Canvas) {
        val c = session.cadenceReading
        val lines = ArrayList<String>()
        lines += String.format(Locale.US, "baseline %s rpm %s speed %.2f light %.1f noise %.1f", if (c.baseline.isNaN()) "-" else "%.1f".format(c.baseline), c.rpm ?: "-", game.speed, game.lightRadius, game.noiseRadius)
        lines += "lane ${session.lane} locked ${game.lockedChoice ?: "-"} brake ${game.brakingForChoice} hold ${session.hold}"
        game.monsters.forEachIndexed { i, m -> lines += String.format(Locale.US, "m%d %s %s speed %.2f gap %.1f", i, m.kind, m.state, m.speed, hypot(m.row - game.riderRow, m.col - game.riderCol)) }
        lines += diagnosticsText
        text.textSize = 10f * density
        val lineHeight = 14f * density
        val left = 8f * density
        val top = TOP_UI + 76f * density
        paint.color = Color.argb(210, 0, 0, 0)
        canvas.drawRect(left, top, width - 8f * density, top + lines.size * lineHeight + 8f * density, paint)
        text.color = Color.WHITE
        lines.forEachIndexed { i, line -> canvas.drawText(line, left + 4f * density, top + (i + 1) * lineHeight, text) }
    }

    private fun banner(canvas: Canvas, value: String, y: Float, color: Int) {
        text.textSize = 19f * density
        text.textAlign = Paint.Align.CENTER
        paint.color = Color.argb(220, 0, 0, 0)
        val half = text.measureText(value) / 2f + 14f * density
        canvas.drawRect(width / 2f - half, y - 27f * density, width / 2f + half, y + 12f * density, paint)
        text.color = color
        canvas.drawText(value, width / 2f, y, text)
        text.textAlign = Paint.Align.LEFT
    }

    private fun project(row: Float, col: Float, ox: Float, oy: Float, tw: Float, th: Float): Pair<Float, Float> {
        val dr = row - cameraRow
        val dc = col - cameraCol
        return ox + (dc - dr) * tw / 2f to oy + (dc + dr) * th / 2f
    }

    private fun diamond(canvas: Canvas, cx: Float, cy: Float, hw: Float, hh: Float, p: Paint) {
        path.reset(); path.moveTo(cx, cy - hh); path.lineTo(cx + hw, cy); path.lineTo(cx, cy + hh); path.lineTo(cx - hw, cy); path.close()
        canvas.drawPath(path, p)
    }

    private fun monsterColor(kind: GhoulMonsterKind): Int = when (kind) {
        GhoulMonsterKind.Ghoul -> Color.rgb(105, 185, 90)
        GhoulMonsterKind.Hound -> Color.rgb(190, 105, 65)
        GhoulMonsterKind.Wraith -> Color.rgb(160, 130, 220)
    }

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

    override fun performClick(): Boolean { super.performClick(); return true }

    private fun newGame(seed: Long): GhoulRunGame = GhoulRunGame(GhoulRunConfig(sprintDelta = SPRINT_DELTAS[difficultyIndex].toFloat()), seed)

    private companion object {
        const val PREFS = "fitbaus_arcade"
        const val DIFFICULTY_KEY = "ghoul_run_sprint_delta"
        const val STALL_NANOS = 500_000_000L
        val SPRINT_DELTAS = intArrayOf(10, 20, 30)
        val BACKGROUND = Color.rgb(7, 8, 12)
        val FLOOR_LIT = Color.rgb(72, 76, 82)
        val FLOOR_EXPLORED = Color.rgb(28, 30, 35)
        val FLOOR_DARK = Color.rgb(10, 11, 15)
        val KEY = Color.rgb(250, 210, 65)
        val SHRINE = Color.rgb(48, 75, 90)
        val SHRINE_ACTIVE = Color.rgb(70, 225, 230)
        val EXIT_LOCKED = Color.rgb(115, 45, 48)
        val EXIT_OPEN = Color.rgb(70, 220, 105)
        val HIGHLIGHT = Color.rgb(255, 225, 70)
        val RIDER = Color.rgb(70, 155, 255)
        val RIDER_INVULNERABLE = Color.WHITE
        const val TOP_UI = 54f
    }
}
