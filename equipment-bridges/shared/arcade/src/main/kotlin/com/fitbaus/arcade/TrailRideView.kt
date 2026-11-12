// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.view.MotionEvent
import android.view.View
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** Pixel-art sprites for TRAIL RIDE, built once from code and small character maps. */
internal object TrailSprites {
    fun rgb(r: Int, g: Int, b: Int): Int = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

    val HAZE: Int = rgb(150, 178, 170)
    val PINE_DARK: Int = rgb(20, 52, 38)
    val PINE_MID: Int = rgb(32, 82, 50)
    val PINE_LIGHT: Int = rgb(70, 124, 62)
    val FIR_DARK: Int = rgb(16, 44, 44)
    val FIR_MID: Int = rgb(26, 70, 62)
    val FIR_LIGHT: Int = rgb(58, 108, 84)
    val LEAF_DARK: Int = rgb(44, 82, 30)
    val LEAF_MID: Int = rgb(72, 118, 40)
    val LEAF_LIGHT: Int = rgb(122, 162, 62)
    val TRUNK: Int = rgb(96, 64, 40)
    val TRUNK_DARK: Int = rgb(58, 38, 24)
    val TRUNK_LIGHT: Int = rgb(132, 94, 60)

    private val CHAR_COLORS = mapOf(
        'K' to rgb(40, 40, 38),
        'D' to rgb(84, 84, 80),
        'G' to rgb(124, 124, 116),
        'L' to rgb(168, 166, 154),
        'd' to LEAF_DARK,
        'm' to LEAF_MID,
        'l' to LEAF_LIGHT,
        'y' to rgb(196, 190, 90),
        'O' to rgb(244, 118, 28),
        'W' to rgb(250, 250, 244),
        'P' to rgb(70, 70, 70),
        's' to rgb(116, 98, 80),
        'S' to rgb(150, 132, 110),
    )

    val ROCK = arrayOf(
        "....LLLL....",
        "..LLGGGGLL..",
        ".LGGGGGGGDD.",
        "LGGGLGGGGGDD",
        "GGGGGGGGDDDD",
        "GGGGGGDDDDDD",
        "DGGGDDDDDDDK",
        ".DDDDDDDDDK.",
    )
    val BUSH = arrayOf(
        "...lml..ll..",
        "..lmmmllmml.",
        ".lmmdmmmmmml",
        "lmmddmmdmmmm",
        "mmdddmddmmdm",
        "mddddddddddm",
        ".dddddddddd.",
    )
    val GRASS = arrayOf(
        "l..l..l",
        "ml.m.lm",
        ".mlmlm.",
        "dmmdmmd",
        ".ddddd.",
    )
    val FLOWERS = arrayOf(
        ".y..W.y",
        "ym.lmym",
        ".mlmlm.",
        "dmmdmmd",
    )
    val STONE = arrayOf(
        ".SS.",
        "sSSs",
    )
    val FLAG = arrayOf(
        "OOOOOP",
        "OOOOP.",
        "OOOP..",
        "OOP...",
        "OP....",
        "WP....",
        "OP....",
        "WP....",
        "OP....",
        "WP....",
        "OP....",
        "WP....",
        "OP....",
        "WP....",
        "OP....",
        "PP....",
    )

    fun bitmap(px: IntArray, w: Int, h: Int): Bitmap = Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)

    /** Layered conifer: tiers widen downward, shaded dark on the left with a few highlights on the right. */
    fun pine(w: Int, h: Int, dark: Int, mid: Int, light: Int, tiers: Int, salt: Int): IntArray {
        val px = IntArray(w * h)
        val trunkH = max(2, h / 8)
        val crownH = h - trunkH
        val cx = (w - 1) / 2f
        for (y in crownH - 1 until h) {
            for (x in floor(cx - 0.5f).toInt()..ceil(cx + 0.5f).toInt()) px[y * w + x] = if (x <= cx) TRUNK_DARK else TRUNK
        }
        for (y in 0 until crownH) {
            val f = y.toFloat() / crownH
            val tier = min(tiers - 1, (f * tiers).toInt())
            val local = f * tiers - tier
            val half = (w / 2f) * (0.22f + 0.78f * (tier + 1f) / tiers) * (0.28f + 0.72f * local)
            val from = ceil(cx - half).toInt().coerceAtLeast(0)
            val to = floor(cx + half).toInt().coerceAtMost(w - 1)
            for (x in from..to) {
                val u = (x - cx) / max(half, 0.5f)
                val n = trailHash(salt.toLong(), y * w + x, 3)
                px[y * w + x] = when {
                    abs(u) > 0.82f || local > 0.9f -> dark
                    u < -0.15f -> if (n < 0.18f) mid else dark
                    n < 0.16f -> light
                    else -> mid
                }
            }
        }
        return px
    }

    /** Broadleaf tree: lumpy round canopy lit from the upper right, short trunk. */
    fun round(w: Int, h: Int, salt: Int): IntArray {
        val px = IntArray(w * h)
        val cx = (w - 1) / 2f
        val trunkTop = (h * 0.55f).toInt()
        for (y in trunkTop until h) for (x in floor(cx - 0.5f).toInt()..ceil(cx + 0.5f).toInt()) px[y * w + x] = if (x <= cx) TRUNK_DARK else TRUNK
        val cy = h * 0.36f
        val rx = w / 2f - 0.3f
        val ry = h * 0.36f
        for (y in 0 until (h * 0.75f).toInt()) {
            for (x in 0 until w) {
                val dx = (x - cx) / rx
                val dy = (y - cy) / ry
                val lump = 0.82f + 0.22f * trailHash(salt.toLong(), (x / 3) * 31 + y / 3, 5)
                val r = dx * dx + dy * dy
                if (r > lump * lump) continue
                val n = trailHash(salt.toLong(), y * w + x, 7)
                val lit = dx - dy
                px[y * w + x] = when {
                    r > lump * lump * 0.8f && lit < 0f -> LEAF_DARK
                    lit > 0.5f -> if (n < 0.5f) LEAF_LIGHT else LEAF_MID
                    lit < -0.4f -> if (n < 0.25f) LEAF_MID else LEAF_DARK
                    else -> if (n < 0.12f) LEAF_LIGHT else LEAF_MID
                }
            }
        }
        return px
    }

    /** Hazard tree standing in the trail: a thick, clearly visible trunk with roots, crown above eye level. */
    fun hazardTree(w: Int, h: Int): IntArray {
        val px = IntArray(w * h)
        val crownH = (h * 0.56f).toInt()
        val crown = pine(w, crownH + 2, PINE_DARK, PINE_MID, PINE_LIGHT, 4, 91)
        for (y in 0 until crownH) for (x in 0 until w) {
            val c = crown[y * w + x]
            if (c != 0) px[y * w + x] = c
        }
        val cx = (w - 1) / 2f
        for (y in crownH - 3 until h) {
            val flare = if (y >= h - 3) (y - (h - 4)) * 1f else 0f
            val half = 2.6f + flare
            for (x in ceil(cx - half).toInt()..floor(cx + half).toInt()) {
                if (x < 0 || x >= w) continue
                val u = (x - cx) / half
                px[y * w + x] = when {
                    u < -0.55f -> TRUNK_DARK
                    u > 0.45f -> TRUNK_LIGHT
                    (x + y / 3) % 4 == 0 -> TRUNK_DARK
                    else -> TRUNK
                }
            }
        }
        return px
    }

    fun hazed(source: IntArray, amount: Float): IntArray = IntArray(source.size) { i -> if (source[i] == 0) 0 else blend(source[i], HAZE, amount) }

    fun charPixels(rows: Array<String>): IntArray {
        val w = rows.maxOf { it.length }
        val px = IntArray(w * rows.size)
        for ((y, row) in rows.withIndex()) for ((x, ch) in row.withIndex()) px[y * w + x] = CHAR_COLORS[ch] ?: 0
        return px
    }

    fun blend(a: Int, b: Int, t: Float): Int {
        val ar = a shr 16 and 0xFF
        val ag = a shr 8 and 0xFF
        val ab = a and 0xFF
        val r = ar + (((b shr 16 and 0xFF) - ar) * t).toInt()
        val g = ag + (((b shr 8 and 0xFF) - ag) * t).toInt()
        val bl = ab + (((b and 0xFF) - ab) * t).toInt()
        return rgb(r, g, bl)
    }
}

private class TrailSprite(val near: Bitmap, val far: Bitmap, val meters: Float)

/**
 * TRAIL RIDE: a first-person mountain-bike ride through an endless forest. Steer with small
 * horizontal head movements (Face tracking), keep pedaling to roll, and jump ditches with a timed,
 * confirmed cadence surge (read-only RPM). Rendered into a 256x144 framebuffer scaled with
 * nearest-neighbour filtering. Never sends anything to the bike.
 */
public class TrailRideView(context: Context) : View(context) {
    public var diagnosticsOverlay: Boolean = false

    private val density = resources.displayMetrics.density
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var sensitivityIndex = (prefs?.getInt(SENSITIVITY_KEY, DEFAULT_SENSITIVITY) ?: DEFAULT_SENSITIVITY).coerceIn(0, SENSITIVITIES.size - 1)
    private var deltaIndex = (prefs?.getInt(DELTA_KEY, DEFAULT_DELTA) ?: DEFAULT_DELTA).coerceIn(0, DELTAS.size - 1)
    private var seedIndex = (prefs?.getInt(SEED_KEY, 0) ?: 0).coerceIn(0, SEEDS.size - 1)
    private var ditchTiming = prefs?.getBoolean(TIMING_KEY, false) ?: false
    private val game = TrailRideGame(seed = nextSeed()).also { g -> g.onEvent = { android.util.Log.i(LandmarkFrameSink.LOG_TAG, it) } }
    private val session = TrailRideSession(game)
    private var simulatedCadence = false
    private var simulatedPress = false
    private var simulatedSample = 0L
    private var diagnosticsText = ""
    private var info: ArcadeCameraInfo? = null
    private var lastRenderNanos = Long.MIN_VALUE
    private val frameWindow = DurationWindow(60)
    private val updateWindow = DurationWindow(60)
    private val drawWindow = DurationWindow(60)
    private var itemsDrawn = 0
    private var memoryText = ""
    private var memoryAtNanos = Long.MIN_VALUE
    private var animSeconds = 0f
    private var hudScore = -1
    private var hudCrashes = -1
    private var hudCrashText = ""
    private var hudScoreText = ""
    private var hudDistanceKey = -1
    private var hudDistanceText = ""
    private var pedalPhase = 0f
    private var barTilt = 0f
    private var wasAirborne = false
    private var landedAt = -10f

    private val projection = TrailProjection(width = LOGICAL_W.toFloat(), horizonY = HORIZON.toFloat())
    private val fb = Bitmap.createBitmap(LOGICAL_W, LOGICAL_H, Bitmap.Config.ARGB_8888)
    private val fbCanvas = Canvas(fb)
    private val pixels = IntArray(LOGICAL_W * LOGICAL_H)
    private val fbSrc = Rect(0, 0, LOGICAL_W, LOGICAL_H)
    private val fbDst = Rect()
    private val skyRows = IntArray(HORIZON + 1) { y -> TrailSprites.blend(SKY_TOP, SKY_HAZE, (y.toFloat() / HORIZON).let { it * it }) }
    private val mountains = IntArray(BACKDROP) { i ->
        val a = 2.0 * PI * i / BACKDROP
        (15 + 6 * sin(3 * a) + 4 * sin(7 * a + 1.3) + 2 * sin(17 * a + 0.4)).toInt()
    }
    private val farTrees = IntArray(BACKDROP) { i ->
        val a = 2.0 * PI * i / BACKDROP
        val tri = abs((i + (trailHash(7L, i / 5, 1) * 3).toInt()) % 5 - 2)
        (5 + 2 * sin(5 * a) + (2 - tri) * 1.6 + trailHash(9L, i / 5, 2) * 3).toInt()
    }
    private val nearTrees = IntArray(BACKDROP) { i ->
        val a = 2.0 * PI * i / BACKDROP
        val tri = abs((i + (trailHash(11L, i / 7, 1) * 4).toInt()) % 7 - 3)
        (3 + 2 * sin(9 * a + 2.0) + (3 - tri) * 1.4 + trailHash(13L, i / 7, 2) * 2).toInt()
    }

    private val pine = sprite(TrailSprites.pine(14, 30, TrailSprites.PINE_DARK, TrailSprites.PINE_MID, TrailSprites.PINE_LIGHT, 5, 1), 14, 30, 8f)
    private val fir = sprite(TrailSprites.pine(12, 30, TrailSprites.FIR_DARK, TrailSprites.FIR_MID, TrailSprites.FIR_LIGHT, 7, 2), 12, 30, 9f)
    private val broad = sprite(TrailSprites.round(16, 20, 3), 16, 20, 6f)
    private val hazardTree = sprite(TrailSprites.hazardTree(20, 48), 20, 48, 6.5f)
    private val bush = charSprite(TrailSprites.BUSH, 0.7f)
    private val grass = charSprite(TrailSprites.GRASS, 0.35f)
    private val flowers = charSprite(TrailSprites.FLOWERS, 0.3f)
    private val rock = charSprite(TrailSprites.ROCK, 0.6f)
    private val stone = charSprite(TrailSprites.STONE, 0.1f)
    private val flag = charSprite(TrailSprites.FLAG, 1.5f)
    private val spriteTable = arrayOf(pine, fir, broad, hazardTree, bush, grass, flowers, rock, stone, flag)

    private val itemZ = FloatArray(MAX_ITEMS)
    private val itemX = FloatArray(MAX_ITEMS)
    private val itemScale = FloatArray(MAX_ITEMS)
    private val itemKind = IntArray(MAX_ITEMS)
    private val order = IntArray(MAX_ITEMS)
    private var itemCount = 0
    private val itemRect = RectF()

    private val px = Paint()
    private val barPaint = Paint().apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.SQUARE
    }
    private val scaledPaint = Paint().apply { isFilterBitmap = false }
    private val hudPaint = Paint().apply {
        color = WHITE
        typeface = Typeface.MONOSPACE
        isFakeBoldText = true
    }
    private val bannerPaint = Paint().apply {
        color = WHITE
        typeface = Typeface.MONOSPACE
        isFakeBoldText = true
        textAlign = Paint.Align.CENTER
    }
    private val backPaint = Paint().apply { color = TrailSprites.rgb(0, 0, 0) and 0x00FFFFFF or (200 shl 24) }
    private val diagPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = WHITE
        typeface = Typeface.MONOSPACE
        textSize = 11f * density
    }
    private val meterRect = RectF()
    private val simRect = RectF()

    init {
        setBackgroundColor(TrailSprites.rgb(0, 0, 0))
        isClickable = true
        session.steering.setGain(SENSITIVITIES[sensitivityIndex])
        session.cadence.setDelta(DELTAS[deltaIndex])
    }

    private val hold: TrailHold
        get() = session.hold

    private val cadenceReading: CadenceReading
        get() = session.cadenceReading

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
    ) {
        val now = System.nanoTime()
        var frameSeconds = 0f
        if (lastRenderNanos != Long.MIN_VALUE) {
            val gap = now - lastRenderNanos
            frameWindow.record(gap / 1_000_000f)
            if (gap > STALL_NANOS) pause() else frameSeconds = gap / 1_000_000_000f
        }
        lastRenderNanos = now
        animSeconds += frameSeconds
        info = cameraInfo
        diagnosticsText = if (failure != null && camera != CameraState.Ready) failure else diagnostics
        val start = System.nanoTime()
        if (simulatedCadence) {
            if (now - simulatedSample >= SIM_SAMPLE_NANOS) simulatedSample = now
            val base = session.cadenceReading.baseline.takeIf { !it.isNaN() } ?: SIM_RPM.toFloat()
            val simRpm = if (simulatedPress) (base + DELTAS[deltaIndex] + 4).toInt() else SIM_RPM
            session.update(position, camera, true, true, simRpm, true, "sim-$simulatedSample", now, simulated = true)
        } else {
            session.update(position, camera, connected, initialized, rpm, rpmCurrent, rpmObservedAt, now)
        }
        val live = session.live
        if (live && game.phase == TrailPhase.Riding) pedalPhase += frameSeconds * (cadenceReading.rpm ?: 0) / 60f * 2f * PI.toFloat()
        updateWindow.record((System.nanoTime() - start) / 1_000_000f)
        val goalTilt = if (live) (game.riderVx / game.config.steerSpeed).coerceIn(-1f, 1f) else 0f
        barTilt += (goalTilt - barTilt) * min(1f, frameSeconds * 10f)
        if (wasAirborne && !game.airborne && game.phase == TrailPhase.Riding) landedAt = animSeconds
        wasAirborne = game.airborne
        val drawStart = System.nanoTime()
        drawWorld()
        drawWindow.record((System.nanoTime() - drawStart) / 1_000_000f)
        invalidate()
    }

    /** Host pause or game switch: stop the clock and forget transient input so nothing stale is replayed. */
    public fun pause() {
        session.pause()
        simulatedPress = false
        lastRenderNanos = Long.MIN_VALUE
    }

    public fun restartGame() {
        session.restart(nextSeed())
        wasAirborne = false
        invalidate()
    }

    public fun developerOptions(): List<String> = listOf(
        "Head sensitivity: ${SENSITIVITY_LABELS[sensitivityIndex]} (tap to change)",
        "Jump surge threshold: +${DELTAS[deltaIndex]} RPM above your baseline (tap to change)",
        "Recenter head now (look straight ahead)",
        if (ditchTiming) "Ditch timing guide: ON (tap to hide)" else "Ditch timing guide: OFF (tap to show)",
        "World seed: ${if (SEEDS[seedIndex] == 0L) "random each ride" else "fixed ${SEEDS[seedIndex]}"} (tap to change, restarts)",
        if (simulatedCadence) "Simulated cadence (dev): ON - SIMULATED, not real pedaling" else "Simulated cadence (dev): OFF",
        "Restart ride now",
    )

    public fun selectDeveloperOption(index: Int) {
        when (index) {
            0 -> {
                sensitivityIndex = (sensitivityIndex + 1) % SENSITIVITIES.size
                session.steering.setGain(SENSITIVITIES[sensitivityIndex])
                prefs?.edit()?.putInt(SENSITIVITY_KEY, sensitivityIndex)?.apply()
            }
            1 -> {
                deltaIndex = (deltaIndex + 1) % DELTAS.size
                session.cadence.setDelta(DELTAS[deltaIndex])
                prefs?.edit()?.putInt(DELTA_KEY, deltaIndex)?.apply()
            }
            2 -> session.recenter()
            3 -> {
                ditchTiming = !ditchTiming
                prefs?.edit()?.putBoolean(TIMING_KEY, ditchTiming)?.apply()
            }
            4 -> {
                seedIndex = (seedIndex + 1) % SEEDS.size
                prefs?.edit()?.putInt(SEED_KEY, seedIndex)?.apply()
                restartGame()
            }
            5 -> {
                simulatedCadence = !simulatedCadence
                simulatedPress = false
                session.resetCadence()
            }
            6 -> restartGame()
        }
        invalidate()
    }

    private fun nextSeed(): Long = SEEDS[seedIndex].takeIf { it != 0L } ?: (System.nanoTime() xor 0x2545F4914F6CDD1DL)

    private fun sprite(source: IntArray, w: Int, h: Int, meters: Float): TrailSprite =
        TrailSprite(TrailSprites.bitmap(source, w, h), TrailSprites.bitmap(TrailSprites.hazed(source, FAR_HAZE), w, h), meters)

    private fun charSprite(rows: Array<String>, meters: Float): TrailSprite {
        val w = rows.maxOf { it.length }
        return sprite(TrailSprites.charPixels(rows), w, rows.size, meters)
    }

    // ---- world rendering -------------------------------------------------------------------

    private fun drawWorld() {
        val p = projection
        val world = game.world
        val ridingVisual = game.phase == TrailPhase.Riding && hold == TrailHold.None
        val bob = if (ridingVisual && !game.airborne) 0.012f * sin(pedalPhase * 2f) else 0f
        p.eyeHeight = EYE_HEIGHT + game.airHeight + bob
        val camX = game.riderX
        val d = game.distance
        val yaw = world.slope(d)
        drawBackdrop(yaw, camX)
        drawGround(d, camX, yaw)
        fb.setPixels(pixels, 0, LOGICAL_W, 0, 0, LOGICAL_W, LOGICAL_H)
        collectItems(d)
        sortItems()
        drawItems(camX, yaw)
        drawHandlebars(ridingVisual)
        val sinceCrash = game.elapsed - game.lastCrashAt
        if (sinceCrash in 0f..CRASH_FLASH_SECONDS) {
            px.color = (((1f - sinceCrash / CRASH_FLASH_SECONDS) * 90f).toInt() shl 24) or 0x00B02010
            fbCanvas.drawRect(0f, 0f, LOGICAL_W.toFloat(), LOGICAL_H.toFloat(), px)
        }
    }

    private fun drawBackdrop(yaw: Float, camX: Float) {
        val p = projection
        val infinityShift = -yaw * p.focal * p.pxPerMeter
        for (y in 0 until HORIZON) pixels.fill(skyRows[y], y * LOGICAL_W, (y + 1) * LOGICAL_W)
        val mShift = (infinityShift * 0.9f).toInt()
        val fShift = (infinityShift - camX * p.pxPerMeter * p.scale(FAR_TREE_Z)).toInt()
        val nShift = (infinityShift - camX * p.pxPerMeter * p.scale(NEAR_TREE_Z)).toInt()
        for (x in 0 until LOGICAL_W) {
            column(x, mountains[(x - mShift).mod(BACKDROP)], MOUNTAIN)
            column(x, farTrees[(x - fShift).mod(BACKDROP)] + 4, FAR_FOREST)
            column(x, nearTrees[(x - nShift).mod(BACKDROP)] + 1, NEAR_FOREST)
        }
    }

    private fun column(x: Int, height: Int, color: Int) {
        val top = (HORIZON - height).coerceAtLeast(0)
        for (y in top until HORIZON) pixels[y * LOGICAL_W + x] = color
    }

    private fun drawGround(d: Float, camX: Float, yaw: Float) {
        val p = projection
        val world = game.world
        val w = world.config.halfWidth
        val ditch = game.nextDitch()
        val blink = (animSeconds * 6f).toInt() % 2 == 0
        val edgeSide = if (game.nearEdge && game.phase == TrailPhase.Riding) (if (game.lateralError > 0f) 1 else -1) else 0
        val windowFar = if (ditch != null) ditch.start - game.config.jumpEarlySeconds * game.speed else Float.NaN
        val windowNear = if (ditch != null) ditch.start - game.config.jumpLateSeconds * game.speed else Float.NaN
        for (y in HORIZON until LOGICAL_H) {
            val row = y * LOGICAL_W
            val zTop = p.depthAt(y.toFloat())
            val z = p.depthAt(y + 0.5f)
            val zBottom = p.depthAt(y + 1f)
            if (z > GROUND_DIST) {
                pixels.fill(FAR_GROUND, row, row + LOGICAL_W)
                continue
            }
            val wd = d + z
            val fog = (z / GROUND_DIST).coerceIn(0f, 1f).let { it * it } * 0.85f
            val ppm = p.pxPerMeter * p.scale(z)
            val cx = p.screenX(p.lateral(world.center(wd), z, camX, yaw), z)
            val hw = w * ppm
            val grassBand = (wd / 3f).toInt() and 1
            val grassColor = TrailSprites.blend(if (grassBand == 0) GRASS_A else GRASS_B, FAR_GROUND, fog)
            pixels.fill(grassColor, row, row + LOGICAL_W)
            val dirtBand = (wd / 1.7f).toInt() and 1
            span(row, cx - hw, cx + hw, TrailSprites.blend(if (dirtBand == 0) DIRT_A else DIRT_B, FAR_GROUND, fog))
            val edge = max(1f, 0.16f * ppm)
            val edgeColor = TrailSprites.blend(EDGE, FAR_GROUND, fog)
            val warnColor = if (blink) WARN_EDGE else edgeColor
            span(row, cx - hw - edge * 0.5f, cx - hw + edge, if (edgeSide < 0) warnColor else edgeColor)
            span(row, cx + hw - edge, cx + hw + edge * 0.5f, if (edgeSide > 0) warnColor else edgeColor)
            if (z < 40f) {
                val rut = max(1f, 0.07f * ppm)
                val rutColor = TrailSprites.blend(RUT, FAR_GROUND, fog)
                span(row, cx - hw * 0.42f - rut / 2f, cx - hw * 0.42f + rut / 2f, rutColor)
                span(row, cx + hw * 0.38f - rut / 2f, cx + hw * 0.38f + rut / 2f, rutColor)
            }
            if (ditchTiming && ditch != null && d + zTop >= windowFar && d + zBottom <= windowNear) {
                span(row, cx - hw * 0.9f, cx - hw * 0.8f, TIMING)
                span(row, cx + hw * 0.8f, cx + hw * 0.9f, TIMING)
            }
            val ditches = game.world.ditches
            for (k in 0 until ditches.size) {
                val dt = ditches[k]
                val nearZ = dt.start - d
                val farZ = dt.end - d
                if (farZ < 0f || nearZ > OBJECT_DIST) continue
                val lipZ = nearZ - LIP_LENGTH
                if (zBottom <= farZ && zTop >= nearZ) {
                    val reach = (w + DITCH_SHOULDER) * ppm
                    val wall = z > nearZ + (farZ - nearZ) * 0.65f
                    span(row, cx - reach, cx + reach, TrailSprites.blend(if (wall) DITCH_WALL else DITCH_DARK, FAR_GROUND, fog * 0.6f))
                } else if (zBottom <= nearZ && zTop >= lipZ) {
                    span(row, cx - hw, cx + hw, TrailSprites.blend(LIP, FAR_GROUND, fog))
                }
            }
        }
    }

    private fun span(row: Int, left: Float, right: Float, color: Int) {
        val l = max(0, left.toInt())
        val r = min(LOGICAL_W, ceil(right).toInt())
        if (r > l) pixels.fill(color, row + l, row + r)
    }

    private fun collectItems(d: Float) {
        itemCount = 0
        val world = game.world
        val w = world.config.halfWidth
        val first = floor(d / SLOT).toInt()
        val last = floor((d + OBJECT_DIST) / SLOT).toInt()
        for (slot in first..last) {
            val base = slot * SLOT
            for (side in 0..1) {
                val sign = if (side == 0) -1f else 1f
                val s = side * 16
                if (world.scenery(slot, s + 1) < 0.85f) {
                    val sd = base + (world.scenery(slot, s + 2) - 0.5f) * SLOT * 0.8f
                    val off = sign * (w + 1.0f + world.scenery(slot, s + 3) * 2.6f)
                    if (sd - d >= MIN_TREE_Z) addItem(sd - d, world.center(sd) + off, treeKind(world.scenery(slot, s + 4)), 0.75f + 0.5f * world.scenery(slot, s + 5))
                }
                if (world.scenery(slot, s + 6) < 0.7f) {
                    val sd = base + (world.scenery(slot, s + 7) - 0.5f) * SLOT
                    val off = sign * (w + 4.2f + world.scenery(slot, s + 8) * 9f)
                    addItem(sd - d, world.center(sd) + off, treeKind(world.scenery(slot, s + 9)), 0.85f + 0.5f * world.scenery(slot, s + 10))
                }
                val shrub = world.scenery(slot, s + 11)
                if (shrub < 0.55f) {
                    val sd = base + (world.scenery(slot, s + 12) - 0.5f) * SLOT
                    val off = sign * (w + 0.3f + world.scenery(slot, s + 13) * 0.6f)
                    val kind = when {
                        shrub < 0.22f -> KIND_BUSH
                        shrub < 0.42f -> KIND_GRASS
                        shrub < 0.48f -> KIND_ROCK
                        else -> KIND_FLOWERS
                    }
                    addItem(sd - d, world.center(sd) + off, kind, if (kind == KIND_ROCK) 0.7f else 0.8f + 0.5f * world.scenery(slot, s + 14))
                }
            }
            if (world.scenery(slot, 40) < 0.22f) {
                val sd = base + world.scenery(slot, 41) * SLOT
                addItem(sd - d, world.center(sd) + (world.scenery(slot, 42) * 2f - 1f) * w * 0.85f, KIND_STONE, 0.8f + world.scenery(slot, 43))
            }
        }
        val obstacles = world.obstacles
        for (k in 0 until obstacles.size) {
            val o = obstacles[k]
            addItem(o.distance - d, o.x, if (o.kind == ObstacleKind.Trunk) KIND_HAZARD_TREE else KIND_ROCK, if (o.kind == ObstacleKind.Trunk) 1f else 1.3f)
        }
        val ditches = world.ditches
        for (k in 0 until ditches.size) {
            val dt = ditches[k]
            val c = world.center(dt.start)
            addItem(dt.start - d, c - w - 0.45f, KIND_FLAG, 1f)
            addItem(dt.start - d, c + w + 0.45f, KIND_FLAG, 1f)
        }
    }

    private fun treeKind(roll: Float): Int = when {
        roll < 0.45f -> KIND_PINE
        roll < 0.8f -> KIND_FIR
        else -> KIND_BROAD
    }

    private fun addItem(z: Float, x: Float, kind: Int, scale: Float) {
        if (z < MIN_ITEM_Z || z > OBJECT_DIST || itemCount >= MAX_ITEMS) return
        itemZ[itemCount] = z
        itemX[itemCount] = x
        itemKind[itemCount] = kind
        itemScale[itemCount] = scale
        order[itemCount] = itemCount
        itemCount += 1
    }

    /** Far to near; insertion sort is near-linear because slots arrive almost ordered. */
    private fun sortItems() {
        for (i in 1 until itemCount) {
            val key = order[i]
            val z = itemZ[key]
            var j = i - 1
            while (j >= 0 && itemZ[order[j]] < z) {
                order[j + 1] = order[j]
                j -= 1
            }
            order[j + 1] = key
        }
    }

    private fun drawItems(camX: Float, yaw: Float) {
        val p = projection
        var drawn = 0
        for (n in 0 until itemCount) {
            val i = order[n]
            val z = itemZ[i]
            val sprite = spriteTable[itemKind[i]]
            val bmp = if (z > FAR_SPRITE_Z) sprite.far else sprite.near
            val h = p.size(sprite.meters * itemScale[i], z)
            if (h < 1f) continue
            val wpx = h * bmp.width / bmp.height
            val sx = p.screenX(p.lateral(itemX[i], z, camX, yaw), z)
            if (sx + wpx / 2f < 0f || sx - wpx / 2f > LOGICAL_W) continue
            val base = p.groundY(z)
            itemRect.set(sx - wpx / 2f, base - h, sx + wpx / 2f, base + max(0.5f, h * 0.02f))
            fbCanvas.drawBitmap(bmp, null, itemRect, null)
            drawn += 1
        }
        itemsDrawn = drawn
    }

    private fun drawHandlebars(riding: Boolean) {
        val c = fbCanvas
        val sinceCrash = game.elapsed - game.lastCrashAt
        val shake = if (sinceCrash in 0f..SHAKE_SECONDS) sin(sinceCrash * 70f) * 3f * (1f - sinceCrash / SHAKE_SECONDS) else 0f
        val sinceLanding = animSeconds - landedAt
        val dip = if (sinceLanding in 0f..0.25f) sin(sinceLanding / 0.25f * PI.toFloat()) * 3f else 0f
        val lift = -game.airHeight * 15f
        val bob = if (riding && !game.airborne) sin(pedalPhase) * 0.8f else 0f
        val rumble = if (riding && game.nearEdge && !game.airborne) (if ((animSeconds * 30f).toInt() % 2 == 0) 0.7f else -0.7f) else 0f
        c.save()
        c.translate(shake + rumble + barTilt * 3f, lift + dip + bob + (if (game.phase == TrailPhase.Crashed) 4f else 0f))
        c.rotate(barTilt * 5f + shake * 0.6f, 128f, 150f)
        px.color = TIRE
        c.drawRect(121f, 137f, 135f, 144f, px)
        px.color = TIRE_TREAD
        for (ty in 138..143 step 2) c.drawRect(123f, ty.toFloat(), 133f, ty + 1f, px)
        px.color = FRAME
        c.drawRect(117f, 132f, 139f, 137f, px)
        px.color = FRAME_LIGHT
        c.drawRect(117f, 132f, 139f, 133f, px)
        px.color = STEM
        c.drawRect(123f, 123f, 133f, 133f, px)
        px.color = STEM_LIGHT
        c.drawRect(123f, 123f, 133f, 124f, px)
        barPaint.color = BAR
        barPaint.strokeWidth = 4f
        c.drawLine(128f, 126f, 94f, 124f, barPaint)
        c.drawLine(94f, 124f, 46f, 120f, barPaint)
        c.drawLine(128f, 126f, 162f, 124f, barPaint)
        c.drawLine(162f, 124f, 210f, 120f, barPaint)
        barPaint.color = BAR_LIGHT
        barPaint.strokeWidth = 1f
        c.drawLine(126f, 124.5f, 94f, 122.5f, barPaint)
        c.drawLine(94f, 122.5f, 48f, 118.5f, barPaint)
        c.drawLine(130f, 124.5f, 162f, 122.5f, barPaint)
        c.drawLine(162f, 122.5f, 208f, 118.5f, barPaint)
        barPaint.color = LEVER
        barPaint.strokeWidth = 2f
        c.drawLine(58f, 121f, 84f, 129f, barPaint)
        c.drawLine(198f, 121f, 172f, 129f, barPaint)
        px.color = LEVER
        c.drawRect(54f, 118f, 60f, 124f, px)
        c.drawRect(196f, 118f, 202f, 124f, px)
        px.color = GRIP
        c.drawRect(24f, 115f, 52f, 125f, px)
        c.drawRect(204f, 115f, 232f, 125f, px)
        px.color = GRIP_RIDGE
        for (gx in 26..50 step 3) {
            c.drawRect(gx.toFloat(), 115f, gx + 1f, 125f, px)
            c.drawRect((256 - gx - 1).toFloat(), 115f, (256 - gx).toFloat(), 125f, px)
        }
        px.color = GLOVE
        c.drawOval(RECT_GLOVE_L, px)
        c.drawOval(RECT_GLOVE_R, px)
        c.drawOval(RECT_THUMB_L, px)
        c.drawOval(RECT_THUMB_R, px)
        px.color = GLOVE_DARK
        for (k in 0..3) {
            c.drawRect(31f + k * 4.5f, 119f, 32f + k * 4.5f, 126f, px)
            c.drawRect(224f - k * 4.5f, 119f, 225f - k * 4.5f, 126f, px)
        }
        px.color = GLOVE_LIGHT
        c.drawRect(31f, 114f, 47f, 115f, px)
        c.drawRect(209f, 114f, 225f, 115f, px)
        px.color = COMPUTER
        c.drawRect(120f, 117f, 136f, 124f, px)
        px.color = COMPUTER_SCREEN
        c.drawRect(122f, 118f, 134f, 122f, px)
        px.color = COMPUTER_DIGIT
        c.drawRect(123f, 120f, 123f + 10f * (game.speed / game.config.maxSpeed).coerceIn(0f, 1f), 121f, px)
        c.restore()
    }

    // ---- screen chrome ---------------------------------------------------------------------

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width
        val h = height
        if (w <= 0 || h <= 0) return
        val hud = (30f * density).toInt()
        val scale = maxOf(1, minOf(w / LOGICAL_W, (h - hud) / LOGICAL_H))
        val dw = LOGICAL_W * scale
        val dh = LOGICAL_H * scale
        val left = (w - dw) / 2
        val top = hud + (h - hud - dh) / 2
        fbDst.set(left, top, left + dw, top + dh)
        canvas.drawBitmap(fb, fbSrc, fbDst, scaledPaint)
        drawHud(canvas, left.toFloat(), top.toFloat(), dw.toFloat())
        val holdText = session.message()
        if (holdText != null) {
            banner(canvas, holdText, w / 2f, top + dh * 0.42f, 7f * scale, WHITE)
        } else {
            prompt()?.let { (text, color) -> banner(canvas, text, w / 2f, top + dh * 0.2f, 7f * scale, color) }
        }
        if (simulatedCadence) drawSimButton(canvas, left + dw.toFloat(), top + dh.toFloat(), scale)
        if (diagnosticsOverlay) drawOverlay(canvas, left.toFloat() + 4f * density, top.toFloat() + 14f * scale)
    }

    private fun banner(canvas: Canvas, text: String, cx: Float, cy: Float, size: Float, color: Int) {
        bannerPaint.textSize = size
        bannerPaint.color = color
        val half = bannerPaint.measureText(text) / 2f + size * 0.6f
        canvas.drawRect(cx - half, cy - size, cx + half, cy + size * 0.55f, backPaint)
        canvas.drawText(text, cx, cy, bannerPaint)
        bannerPaint.color = WHITE
    }

    /** One contextual prompt at a time, most important first. */
    private fun prompt(): Pair<String, Int>? {
        val g = game
        val now = g.elapsed
        val blink = (animSeconds * 4f).toInt() % 2 == 0
        if (g.phase == TrailPhase.Crashed) {
            return when (g.lastCrash) {
                TrailCrash.Obstacle -> "CRASH! WATCH THE TREES"
                TrailCrash.OffTrail -> "OFF THE TRAIL!"
                TrailCrash.Ditch -> "MISSED THE JUMP!"
                TrailCrash.None -> "CRASH!"
            } to WARN_TEXT
        }
        if (g.phase == TrailPhase.Ready) return "READY... ${ceil(g.readyLeft).toInt().coerceAtLeast(1)}" to WHITE
        if (now - g.lastClearAt < 1.3f) return "NICE JUMP! +${TrailRideGame.JUMP_POINTS}" to GOOD_TEXT
        if (g.jumpQualified) return "JUMP!" to GOOD_TEXT
        if (now - g.lastJumpAt < 1.2f) {
            when (g.lastJump) {
                JumpResult.Early -> return "TOO EARLY!" to WARN_TEXT
                JumpResult.Late -> return "TOO LATE!" to WARN_TEXT
                else -> Unit
            }
        }
        val ditch = g.nextDitch()
        if (ditch != null && g.phase == TrailPhase.Riding && ditch.start > g.distance) {
            val t = g.timeTo(ditch)
            if (t <= g.config.jumpEarlySeconds + g.config.surgeCueLead && t >= g.config.jumpLateSeconds) {
                return (if (cadenceReading.armed) "SURGE NOW!" else "EASE OFF, THEN SURGE!") to (if (blink) PROMPT_TEXT else WHITE)
            }
            if (t <= DITCH_WARN_SECONDS) return "DITCH AHEAD - GET READY TO SURGE" to PROMPT_TEXT
        }
        if (g.phase == TrailPhase.Riding && g.nearEdge && !g.airborne) {
            return (if (g.lateralError > 0f) "<< STEER LEFT" else "STEER RIGHT >>") to (if (blink) WARN_TEXT else WHITE)
        }
        return null
    }

    private fun drawHud(canvas: Canvas, left: Float, top: Float, width: Float) {
        hudPaint.textSize = 16f * density
        hudPaint.color = WHITE
        val baseline = top - 8f * density
        if (game.score != hudScore) {
            hudScore = game.score
            hudScoreText = String.format(Locale.US, "SCORE %06d", hudScore)
        }
        canvas.drawText(hudScoreText, left, baseline, hudPaint)
        var x = left + hudPaint.measureText(hudScoreText) + hudPaint.measureText("  ")
        hudPaint.textSize = 13f * density
        if (game.crashes != hudCrashes) {
            hudCrashes = game.crashes
            hudCrashText = "CRASHES $hudCrashes"
        }
        hudPaint.color = if (hudCrashes > 0) CRASH_TEXT else WHITE
        canvas.drawText(hudCrashText, x, baseline - 1f * density, hudPaint)
        hudPaint.color = WHITE
        x += hudPaint.measureText(hudCrashText) + 14f * density
        val tens = (game.distance / 10f).toInt() * 100 + game.level
        if (tens != hudDistanceKey) {
            hudDistanceKey = tens
            hudDistanceText = String.format(Locale.US, "%.2f KM  LV %d", game.distance / 1000f, game.level + 1)
        }
        canvas.drawText(hudDistanceText, x, baseline - 1f * density, hudPaint)
        val c = cadenceReading
        val meterW = 160f * density
        val meterLeft = left + width - meterW
        meterRect.set(meterLeft, baseline - 14f * density, meterLeft + meterW, baseline)
        px.color = METER_BACK
        canvas.drawRect(meterRect, px)
        val fill = if (c.baseline.isNaN() || c.rpm == null) 0f else ((c.rpm - c.baseline) / (c.threshold - c.baseline)).coerceIn(0f, 1f)
        px.color = when (c.state) {
            CadenceState.Boosting -> METER_BOOST
            CadenceState.Cruising -> if (c.armed) METER_READY else METER_IDLE
            else -> METER_IDLE
        }
        val shown = if (c.state == CadenceState.Boosting) 1f else fill
        canvas.drawRect(meterRect.left, meterRect.top, meterRect.left + meterW * shown, meterRect.bottom, px)
        val label = when (c.state) {
            CadenceState.Boosting -> "SURGE!"
            CadenceState.Establishing -> "LEARNING PACE"
            CadenceState.Cruising -> if (c.armed) "SURGE TO JUMP" else "EASE OFF TO REARM"
            else -> "JUMP --"
        }
        hudPaint.textSize = 12f * density
        val labelText = if (c.simulated) "SIMULATED $label" else label
        hudPaint.color = if (c.simulated) WARN_TEXT else WHITE
        canvas.drawText(labelText, meterLeft - hudPaint.measureText(labelText) - 8f * density, baseline - 2f * density, hudPaint)
        hudPaint.color = WHITE
    }

    private fun drawSimButton(canvas: Canvas, right: Float, bottom: Float, scale: Int) {
        simRect.set(right - 140f * density, bottom - 50f * density, right - 8f * density, bottom - 8f * density)
        px.color = if (simulatedPress) METER_BOOST else SIM_BUTTON
        canvas.drawRect(simRect, px)
        bannerPaint.textSize = 4f * scale
        canvas.drawText("SIMULATED SURGE", simRect.centerX(), simRect.centerY() + bannerPaint.textSize / 3f, bannerPaint)
    }

    private fun drawOverlay(canvas: Canvas, left: Float, top: Float) {
        val now = System.nanoTime()
        if (memoryAtNanos == Long.MIN_VALUE || now - memoryAtNanos > 1_000_000_000L) {
            memoryAtNanos = now
            val runtime = Runtime.getRuntime()
            memoryText = String.format(
                Locale.US,
                "mem java %.1f MB native %.1f MB",
                (runtime.totalMemory() - runtime.freeMemory()) / 1048576f,
                android.os.Debug.getNativeHeapAllocatedSize() / 1048576f,
            )
        }
        val s = session.steer
        val c = cadenceReading
        val g = game
        val d = info?.diagnostics
        val ditch = g.nextDitch()
        val ditchText = if (ditch == null) {
            "none"
        } else {
            String.format(Locale.US, "%.1f m / %.2f s (window %.2f..%.2f s)", ditch.start - g.distance, g.timeTo(ditch), g.config.jumpLateSeconds, g.config.jumpEarlySeconds)
        }
        val lines = listOf(
            String.format(
                Locale.US, "face %.1f Hz  %s  x %.3f  neutral %s  age %d ms  stable %d ms  gain %.1f  steer %+.2f",
                d?.processedHz ?: Float.NaN, s.state, s.faceX, if (s.neutralX.isNaN()) "-" else String.format(Locale.US, "%.3f", s.neutralX),
                s.ageMs, s.stableMs, session.steering.config.gain, s.steer,
            ),
            String.format(
                Locale.US, "rider x %+.2f  target %+.2f  trail %+.2f  error %+.2f (limit %.2f)  vx %+.2f  speed %.1f m/s  %s  hold %s",
                g.riderX, g.targetX, g.world.center(g.distance), g.lateralError, g.config.world.halfWidth + g.config.edgeTolerance,
                g.riderVx, g.speed, g.phase, hold,
            ),
            String.format(
                Locale.US, "rpm %s%s  age %d ms  baseline %s  threshold %s  %s  boost %d ms  surges %d  armed %s",
                c.rpm?.toString() ?: "-", if (c.simulated) " (SIMULATED)" else "", c.sampleAgeMs,
                if (c.baseline.isNaN()) "-" else String.format(Locale.US, "%.1f", c.baseline),
                if (c.threshold.isNaN()) "-" else String.format(Locale.US, "%.1f", c.threshold),
                c.state, c.boostRemainingMs, c.activations, if (c.armed) "yes" else "no",
            ),
            String.format(
                Locale.US, "jump %s  air %.2f s  last %s (%.2f s to ditch)  next ditch %s",
                if (g.jumpQualified) "AIRBORNE-QUALIFIED" else if (g.airborne) "hop" else "grounded",
                g.airLeft, g.lastJump, g.jumpTimeToDitch, ditchText,
            ),
            String.format(
                Locale.US, "last crash %s  crashes %d (hits %d  off-trail %d  ditch misses %d)  jumps %d  dodged %d  level %d  %.0f m  t %.0f s",
                g.lastCrash, g.crashes, g.obstacleHits, g.offTrails, g.ditchesMissed, g.jumpsCleared, g.dodged, g.level + 1, g.distance, g.elapsed,
            ),
            String.format(
                Locale.US, "frame p50 %.0f / p90 %.0f ms  update p50 %.2f / p90 %.2f ms  draw p50 %.1f / p90 %.1f ms  steps %d  sprites %d  cpu %s  %s",
                frameWindow.percentile(0.5f), frameWindow.percentile(0.9f), updateWindow.percentile(0.5f), updateWindow.percentile(0.9f),
                drawWindow.percentile(0.5f), drawWindow.percentile(0.9f), session.lastSteps, itemsDrawn,
                d?.processCpuPercent?.let { if (it.isNaN()) "-" else String.format(Locale.US, "%.0f%%", it) } ?: "-", memoryText,
            ),
            String.format(
                Locale.US, "seed %d  obstacles %d held / %d made  ditches %d held / %d made  path points %d",
                g.world.seed, g.world.obstacles.size, g.world.generatedObstacles, g.world.ditches.size, g.world.generatedDitches, g.world.pointsHeld,
            ),
            "events: " + g.events.takeLast(3).joinToString(" | ") { String.format(Locale.US, "%.0fs %s", it.atSeconds, it.text) },
            diagnosticsText,
        )
        val lineHeight = diagPaint.textSize + 3f * density
        val boxW = lines.maxOf { diagPaint.measureText(it) } + 12f * density
        canvas.drawRect(left, top, left + boxW, top + lines.size * lineHeight + 6f * density, backPaint)
        var y = top + lineHeight
        for (line in lines) {
            canvas.drawText(line, left + 6f * density, y, diagPaint)
            y += lineHeight
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (simulatedCadence && simRect.contains(event.x, event.y)) {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> simulatedPress = true
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> simulatedPress = false
            }
            if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
            return true
        }
        if (event.actionMasked == MotionEvent.ACTION_CANCEL) simulatedPress = false
        if (event.actionMasked == MotionEvent.ACTION_UP) {
            simulatedPress = false
            performClick()
        }
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private companion object {
        const val LOGICAL_W = 256
        const val LOGICAL_H = 144
        const val HORIZON = 50
        const val BACKDROP = 512
        const val EYE_HEIGHT = 1.52f
        const val GROUND_DIST = 160f
        const val OBJECT_DIST = 80f
        const val FAR_SPRITE_Z = 34f
        const val FAR_HAZE = 0.38f
        const val FAR_TREE_Z = 120f
        const val NEAR_TREE_Z = 70f
        const val MIN_ITEM_Z = 0.35f
        const val MIN_TREE_Z = 3f
        const val SLOT = 2.5f
        const val MAX_ITEMS = 320
        const val LIP_LENGTH = 0.7f
        const val DITCH_SHOULDER = 1.6f
        const val CRASH_FLASH_SECONDS = 0.25f
        const val SHAKE_SECONDS = 0.5f
        const val DITCH_WARN_SECONDS = 4.5f
        const val STALL_NANOS = 500_000_000L
        const val KIND_PINE = 0
        const val KIND_FIR = 1
        const val KIND_BROAD = 2
        const val KIND_HAZARD_TREE = 3
        const val KIND_BUSH = 4
        const val KIND_GRASS = 5
        const val KIND_FLOWERS = 6
        const val KIND_ROCK = 7
        const val KIND_STONE = 8
        const val KIND_FLAG = 9
        const val PREFS = "fitbaus_arcade"
        const val SENSITIVITY_KEY = "trail_sensitivity"
        const val DELTA_KEY = "trail_boost_delta"
        const val SEED_KEY = "trail_seed"
        const val TIMING_KEY = "trail_ditch_timing"
        const val DEFAULT_SENSITIVITY = 1
        const val DEFAULT_DELTA = 2
        const val SIM_RPM = 70
        const val SIM_SAMPLE_NANOS = 200_000_000L
        val SENSITIVITIES = floatArrayOf(3f, 4f, 5.5f, 7f)
        val SENSITIVITY_LABELS = arrayOf("Low", "Medium", "High", "Very high")
        val DELTAS = intArrayOf(8, 10, 12, 15, 18)
        val SEEDS = longArrayOf(0L, 1001L, 2024L, 7777L)
        val RECT_GLOVE_L = RectF(27f, 113f, 51f, 128f)
        val RECT_GLOVE_R = RectF(205f, 113f, 229f, 128f)
        val RECT_THUMB_L = RectF(45f, 111f, 56f, 119f)
        val RECT_THUMB_R = RectF(200f, 111f, 211f, 119f)
        val WHITE = TrailSprites.rgb(252, 252, 252)
        val SKY_TOP = TrailSprites.rgb(86, 140, 200)
        val SKY_HAZE = TrailSprites.rgb(196, 218, 214)
        val MOUNTAIN = TrailSprites.rgb(120, 146, 160)
        val FAR_FOREST = TrailSprites.rgb(60, 98, 92)
        val NEAR_FOREST = TrailSprites.rgb(30, 66, 52)
        val FAR_GROUND = TrailSprites.rgb(56, 92, 64)
        val GRASS_A = TrailSprites.rgb(74, 124, 50)
        val GRASS_B = TrailSprites.rgb(64, 112, 44)
        val DIRT_A = TrailSprites.rgb(156, 112, 68)
        val DIRT_B = TrailSprites.rgb(146, 104, 62)
        val RUT = TrailSprites.rgb(118, 82, 50)
        val EDGE = TrailSprites.rgb(96, 70, 42)
        val WARN_EDGE = TrailSprites.rgb(236, 92, 40)
        val LIP = TrailSprites.rgb(186, 142, 92)
        val DITCH_DARK = TrailSprites.rgb(30, 20, 14)
        val DITCH_WALL = TrailSprites.rgb(92, 62, 38)
        val TIMING = TrailSprites.rgb(80, 240, 120)
        val TIRE = TrailSprites.rgb(28, 28, 30)
        val TIRE_TREAD = TrailSprites.rgb(52, 52, 54)
        val FRAME = TrailSprites.rgb(30, 110, 170)
        val FRAME_LIGHT = TrailSprites.rgb(90, 170, 220)
        val STEM = TrailSprites.rgb(44, 44, 50)
        val STEM_LIGHT = TrailSprites.rgb(110, 110, 120)
        val BAR = TrailSprites.rgb(46, 46, 52)
        val BAR_LIGHT = TrailSprites.rgb(130, 130, 140)
        val LEVER = TrailSprites.rgb(150, 150, 158)
        val GRIP = TrailSprites.rgb(22, 22, 22)
        val GRIP_RIDGE = TrailSprites.rgb(56, 56, 56)
        val GLOVE = TrailSprites.rgb(200, 64, 40)
        val GLOVE_DARK = TrailSprites.rgb(130, 36, 24)
        val GLOVE_LIGHT = TrailSprites.rgb(236, 120, 84)
        val COMPUTER = TrailSprites.rgb(20, 20, 24)
        val COMPUTER_SCREEN = TrailSprites.rgb(110, 150, 100)
        val COMPUTER_DIGIT = TrailSprites.rgb(20, 40, 20)
        val CRASH_TEXT = TrailSprites.rgb(236, 170, 150)
        val METER_BACK = TrailSprites.rgb(40, 40, 40)
        val METER_BOOST = TrailSprites.rgb(252, 160, 68)
        val METER_READY = TrailSprites.rgb(0, 200, 90)
        val METER_IDLE = TrailSprites.rgb(110, 110, 110)
        val SIM_BUTTON = TrailSprites.rgb(60, 60, 60) and 0x00FFFFFF or (200 shl 24)
        val WARN_TEXT = TrailSprites.rgb(252, 140, 60)
        val GOOD_TEXT = TrailSprites.rgb(120, 240, 120)
        val PROMPT_TEXT = TrailSprites.rgb(252, 224, 100)
    }
}
