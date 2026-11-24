// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
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

/** Shared palette interpolation for procedural Trail Ride scenery. */
internal object TrailSprites {
    fun rgb(r: Int, g: Int, b: Int): Int = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

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
 * horizontal head movements (Face tracking), keep pedaling to roll, and jump ditches by standing
 * until the upward-moving face leaves the camera view. The 256x144 world coordinates are
 * composited into a 512x288 antialiased framebuffer. Never sends anything to the bike.
 */
public class TrailRideView(context: Context) : View(context) {
    public var diagnosticsOverlay: Boolean = false

    private val density = resources.displayMetrics.density
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var sensitivityIndex = (prefs?.getInt(SENSITIVITY_KEY, DEFAULT_SENSITIVITY) ?: DEFAULT_SENSITIVITY).coerceIn(0, SENSITIVITIES.size - 1)
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
    private val fb = Bitmap.createBitmap(
        TrailRideArtwork.PRESENTATION_WIDTH,
        TrailRideArtwork.PRESENTATION_HEIGHT,
        Bitmap.Config.ARGB_8888,
    )
    private val fbCanvas = Canvas(fb)
    private val terrain = Bitmap.createBitmap(LOGICAL_W, LOGICAL_H, Bitmap.Config.ARGB_8888)
    private val terrainDst = RectF(0f, 0f, TrailRideArtwork.PRESENTATION_WIDTH.toFloat(), TrailRideArtwork.PRESENTATION_HEIGHT.toFloat())
    private val pixels = IntArray(LOGICAL_W * LOGICAL_H)
    private val fbSrc = Rect(0, 0, TrailRideArtwork.PRESENTATION_WIDTH, TrailRideArtwork.PRESENTATION_HEIGHT)
    private val fbDst = Rect()
    private val skyRows = IntArray(HORIZON + 1) { y ->
        val t = y.toFloat() / HORIZON
        if (t < 0.65f) TrailSprites.blend(SKY_TOP, SKY_MID, t / 0.65f)
        else TrailSprites.blend(SKY_MID, SKY_HAZE, (t - 0.65f) / 0.35f)
    }
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

    private val pine = sprite(TrailRideArtwork.Kind.Pine, 14, 30, 8f)
    private val fir = sprite(TrailRideArtwork.Kind.Fir, 12, 30, 9f)
    private val broad = sprite(TrailRideArtwork.Kind.Broad, 16, 20, 6f)
    private val hazardTree = sprite(TrailRideArtwork.Kind.HazardTree, 20, 48, 6.5f)
    private val bush = sprite(TrailRideArtwork.Kind.Bush, 12, 7, 0.7f)
    private val grass = sprite(TrailRideArtwork.Kind.Grass, 7, 5, 0.35f)
    private val flowers = sprite(TrailRideArtwork.Kind.Flowers, 7, 4, 0.3f)
    private val rock = sprite(TrailRideArtwork.Kind.Rock, 12, 8, 0.6f)
    private val stone = sprite(TrailRideArtwork.Kind.Stone, 4, 2, 0.1f)
    private val flag = sprite(TrailRideArtwork.Kind.Flag, 6, 16, 1.5f)
    private val tortoiseRightA = sprite(TrailRideArtwork.Kind.Tortoise, 22, 12, 0.48f, stride = 0)
    private val tortoiseRightB = sprite(TrailRideArtwork.Kind.Tortoise, 22, 12, 0.48f, stride = 1)
    private val tortoiseLeftA = sprite(TrailRideArtwork.Kind.Tortoise, 22, 12, 0.48f, stride = 0, facingRight = false)
    private val tortoiseLeftB = sprite(TrailRideArtwork.Kind.Tortoise, 22, 12, 0.48f, stride = 1, facingRight = false)
    private val spriteTable = arrayOf(
        pine, fir, broad, hazardTree, bush, grass, flowers, rock, stone, flag,
        tortoiseRightA, tortoiseRightB, tortoiseLeftA, tortoiseLeftB,
    )

    private val itemZ = FloatArray(MAX_ITEMS)
    private val itemX = FloatArray(MAX_ITEMS)
    private val itemScale = FloatArray(MAX_ITEMS)
    private val itemKind = IntArray(MAX_ITEMS)
    private val order = IntArray(MAX_ITEMS)
    private var itemCount = 0
    private val itemRect = RectF()

    private val px = Paint(Paint.ANTI_ALIAS_FLAG).apply { isDither = true }
    private val cockpit = TrailRideCockpit()
    private val spritePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { isDither = true }
    private val shadowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(56, 30, 39, 31) }
    private val cloudPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val itemShadow = RectF()
    private val scaledPaint = Paint(Paint.FILTER_BITMAP_FLAG).apply { isDither = true }
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
            val simRpm = if (simulatedPress) SIM_RPM + 30 else SIM_RPM
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

    public fun restartShowcase() {
        session.restart(1001L)
        wasAirborne = false
        invalidate()
    }

    public fun showcaseJumpIfReady() {
        val ditch = game.nextDitch() ?: return
        if (game.phase == TrailPhase.Riding && !game.airborne && game.timeTo(ditch) in game.config.jumpLateSeconds..game.config.jumpEarlySeconds) game.requestJump()
    }

    public fun restartGame() {
        session.restart(nextSeed())
        wasAirborne = false
        invalidate()
    }

    public fun developerOptions(): List<String> = listOf(
        "Head sensitivity: ${SENSITIVITY_LABELS[sensitivityIndex]} (tap to change)",
        "Recenter head now (look straight ahead)",
        if (ditchTiming) "Ditch timing guide: ON (tap to hide)" else "Ditch timing guide: OFF (tap to show)",
        "World seed: ${if (SEEDS[seedIndex] == 0L) "random each ride" else "fixed ${SEEDS[seedIndex]}"} (tap to change, restarts)",
        if (simulatedCadence) "Simulated cadence (dev): ON - SIMULATED, not real pedaling" else "Simulated cadence (dev): OFF",
        "Test jump animation (dev)",
        "Restart ride now",
    )

    public fun selectDeveloperOption(index: Int) {
        when (index) {
            0 -> {
                sensitivityIndex = (sensitivityIndex + 1) % SENSITIVITIES.size
                session.steering.setGain(SENSITIVITIES[sensitivityIndex])
                prefs?.edit()?.putInt(SENSITIVITY_KEY, sensitivityIndex)?.apply()
            }
            1 -> session.recenter()
            2 -> {
                ditchTiming = !ditchTiming
                prefs?.edit()?.putBoolean(TIMING_KEY, ditchTiming)?.apply()
            }
            3 -> {
                seedIndex = (seedIndex + 1) % SEEDS.size
                prefs?.edit()?.putInt(SEED_KEY, seedIndex)?.apply()
                restartGame()
            }
            4 -> {
                simulatedCadence = !simulatedCadence
                simulatedPress = false
                session.resetCadence()
            }
            5 -> if (game.phase == TrailPhase.Riding) game.requestJump()
            6 -> restartGame()
        }
        invalidate()
    }

    private fun nextSeed(): Long = SEEDS[seedIndex].takeIf { it != 0L } ?: (System.nanoTime() xor 0x2545F4914F6CDD1DL)

    private fun sprite(
        kind: TrailRideArtwork.Kind, w: Int, h: Int, meters: Float,
        stride: Int = 0, facingRight: Boolean = true,
    ): TrailSprite {
        val art = TrailRideArtwork.create(kind, w, h, stride, facingRight)
        return TrailSprite(art, TrailRideArtwork.hazed(art, FAR_HAZE), meters)
    }

    // ---- world rendering -------------------------------------------------------------------

    private fun visualJumpHeight(): Float =
        game.airHeight * if (game.jumpQualified) 1.8f else 3.3f

    private fun drawWorld() {
        val p = projection
        val world = game.world
        val ridingVisual = game.phase == TrailPhase.Riding && hold == TrailHold.None
        val bob = if (ridingVisual && !game.airborne) 0.012f * sin(pedalPhase * 2f) else 0f
        p.eyeHeight = EYE_HEIGHT + visualJumpHeight() + bob
        val camX = game.riderX
        val d = game.distance
        val yaw = world.slope(d)
        drawBackdrop(yaw, camX)
        drawGround(d, camX, yaw)
        terrain.setPixels(pixels, 0, LOGICAL_W, 0, 0, LOGICAL_W, LOGICAL_H)
        fbCanvas.drawBitmap(terrain, null, terrainDst, scaledPaint)
        val saved = fbCanvas.save()
        fbCanvas.scale(TrailRideArtwork.PRESENTATION_SCALE.toFloat(), TrailRideArtwork.PRESENTATION_SCALE.toFloat())
        drawSkyAtmosphere(yaw)
        collectItems(d)
        sortItems()
        drawItems(camX, yaw)
        drawHandlebars(ridingVisual)
        val sinceCrash = game.elapsed - game.lastCrashAt
        if (sinceCrash in 0f..CRASH_FLASH_SECONDS) {
            px.color = (((1f - sinceCrash / CRASH_FLASH_SECONDS) * 90f).toInt() shl 24) or 0x00B02010
            fbCanvas.drawRect(0f, 0f, LOGICAL_W.toFloat(), LOGICAL_H.toFloat(), px)
        }
        fbCanvas.restoreToCount(saved)
    }

    private fun drawSkyAtmosphere(yaw: Float) {
        val shift = yaw * 15f
        for (i in 0..4) {
            val x = ((i * 73f + 21f - shift) % 340f + 340f) % 340f - 25f
            val y = 9f + (i * 13) % 23
            cloudPaint.color = Color.argb(34, 247, 243, 229)
            fbCanvas.drawOval(x - 29f, y - 3.5f, x + 32f, y + 2.4f, cloudPaint)
            cloudPaint.color = Color.argb(20, 240, 234, 222)
            fbCanvas.drawOval(x - 19f, y - 5f, x + 23f, y + 1.5f, cloudPaint)
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
            val mountainHeight = mountains[(x - mShift).mod(BACKDROP)]
            column(x, mountainHeight, MOUNTAIN)
            if (mountainHeight > 0 && HORIZON - mountainHeight in 0 until HORIZON) {
                pixels[(HORIZON - mountainHeight) * LOGICAL_W + x] = MOUNTAIN_RIDGE
            }
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
            if (z < 45f && y % 2 == 0) {
                val patch = (wd * 2f).toInt()
                for (i in 0..4) {
                    val noise = trailHash(79L, patch, i + 31)
                    val tx = cx + (noise * 1.6f - 0.8f) * hw
                    val shade = if (i % 2 == 0) DIRT_LIGHT else DIRT_SHADOW
                    span(row, tx, tx + max(0.8f, ppm * 0.025f),
                        TrailSprites.blend(shade, FAR_GROUND, fog))
                }
            }
            val edge = max(1f, 0.16f * ppm)
            val edgeColor = TrailSprites.blend(EDGE, FAR_GROUND, fog)
            span(row, cx - hw - edge * 0.5f, cx - hw + edge, edgeColor)
            span(row, cx + hw - edge, cx + hw + edge * 0.5f, edgeColor)
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
            val kind = when (o.kind) {
                ObstacleKind.Trunk -> KIND_HAZARD_TREE
                ObstacleKind.Rock -> KIND_ROCK
                ObstacleKind.Tortoise -> {
                    val stride = ((d * 1.25f).toInt() and 1)
                    if (o.crossingDirection > 0) KIND_TORTOISE_LEFT_A + stride
                    else KIND_TORTOISE_RIGHT_A + stride
                }
            }
            val scale = when (o.kind) {
                ObstacleKind.Trunk -> 1f
                ObstacleKind.Rock -> 1.3f
                ObstacleKind.Tortoise -> 1f
            }
            addItem(o.distance - d, o.positionAt(d, w), kind, scale)
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
            if (z < 32f && h > 5f) {
                itemShadow.set(sx - wpx * 0.31f, base - h * 0.02f,
                    sx + wpx * 0.37f, base + h * 0.055f)
                fbCanvas.drawOval(itemShadow, shadowPaint)
            }
            fbCanvas.drawBitmap(bmp, null, itemRect, spritePaint)
            drawn += 1
        }
        itemsDrawn = drawn
    }

    private fun drawHandlebars(riding: Boolean) {
        val sinceCrash = game.elapsed - game.lastCrashAt
        val shake = if (sinceCrash in 0f..SHAKE_SECONDS)
            sin(sinceCrash * 70f) * 3f * (1f - sinceCrash / SHAKE_SECONDS) else 0f
        val sinceLanding = animSeconds - landedAt
        val dip = if (sinceLanding in 0f..0.25f)
            sin(sinceLanding / 0.25f * PI.toFloat()) * 3f else 0f
        val lift = -visualJumpHeight() * 15f
        val bob = if (riding && !game.airborne) sin(pedalPhase) * 0.8f else 0f
        val rumble = if (riding && game.nearEdge && !game.airborne)
            (if ((animSeconds * 30f).toInt() % 2 == 0) 0.7f else -0.7f) else 0f
        val saved = fbCanvas.save()
        fbCanvas.translate(shake + rumble + barTilt * 3f, lift + dip + bob +
            (if (game.phase == TrailPhase.Crashed) 4f else 0f))
        fbCanvas.rotate(barTilt * 5f + shake * 0.6f, 128f, 150f)
        cockpit.draw(fbCanvas, game.speed / game.config.maxSpeed)
        fbCanvas.restoreToCount(saved)
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
                TrailCrash.Obstacle -> "CRASH! AVOID OBSTACLES"
                TrailCrash.OffTrail -> "OFF THE TRAIL!"
                TrailCrash.Ditch -> "MISSED THE JUMP!"
                TrailCrash.None -> "CRASH!"
            } to WARN_TEXT
        }
        if (g.phase == TrailPhase.Ready) return "READY... ${ceil(g.readyLeft).toInt().coerceAtLeast(1)}" to WHITE
        if (now - g.lastClearAt < 1.3f) return "NICE JUMP! +${TrailRideGame.JUMP_POINTS}" to GOOD_TEXT
        if (g.airborne) return (if (g.jumpQualified) "JUMP!" else "HOP!") to GOOD_TEXT
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
            if (t <= g.config.jumpEarlySeconds + g.config.jumpCueLead && t >= g.config.jumpLateSeconds) {
                return "STAND UP TO JUMP!" to PROMPT_TEXT
            }
            if (t <= DITCH_WARN_SECONDS) return "DITCH AHEAD - GET READY TO STAND" to PROMPT_TEXT
        }
        if (g.phase == TrailPhase.Riding && g.offTrail) {
            return "OFF TRAIL - SLIGHT SLOWDOWN" to (if (blink) WARN_TEXT else WHITE)
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
        val shown = ((c.rpm ?: 0).toFloat() / game.config.maxSpeedRpm).coerceIn(0f, 1f)
        px.color = if (c.pedaling) METER_READY else METER_IDLE
        canvas.drawRect(meterRect.left, meterRect.top, meterRect.left + meterW * shown, meterRect.bottom, px)
        hudPaint.textSize = 12f * density
        val labelText = if (c.simulated) "SIM RPM ${c.rpm ?: 0}" else "RPM ${c.rpm ?: 0}"
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
                Locale.US, "rpm %s%s  age %d ms  state %s  speed %.1f m/s  face Y %.3f  stand armed %s  rise %.3f  last %s  jump events %d",
                c.rpm?.toString() ?: "-", if (c.simulated) " (SIMULATED)" else "",
                c.sampleAgeMs, c.state, g.speed, session.standing.lastY,
                if (session.standing.armed) "yes" else "no",
                session.standing.lastRise, session.standing.lastEvent, session.standing.jumps,
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
        const val KIND_TORTOISE_RIGHT_A = 10
        const val KIND_TORTOISE_RIGHT_B = 11
        const val KIND_TORTOISE_LEFT_A = 12
        const val KIND_TORTOISE_LEFT_B = 13
        const val PREFS = "fitbaus_arcade"
        const val SENSITIVITY_KEY = "trail_sensitivity"
        const val SEED_KEY = "trail_seed"
        const val TIMING_KEY = "trail_ditch_timing"
        const val DEFAULT_SENSITIVITY = 1
        const val SIM_RPM = 70
        const val SIM_SAMPLE_NANOS = 200_000_000L
        val SENSITIVITIES = floatArrayOf(1.6f, 2.4f, 3.2f, 4.2f)
        val SENSITIVITY_LABELS = arrayOf("Low", "Medium", "High", "Very high")
        val SEEDS = longArrayOf(0L, 1001L, 2024L, 7777L)
        val WHITE = TrailSprites.rgb(252, 252, 252)
        val SKY_TOP = TrailSprites.rgb(57, 104, 143)
        val SKY_MID = TrailSprites.rgb(127, 164, 174)
        val SKY_HAZE = TrailSprites.rgb(206, 217, 197)
        val MOUNTAIN = TrailSprites.rgb(145, 158, 153)
        val MOUNTAIN_RIDGE = TrailSprites.rgb(187, 194, 180)
        val FAR_FOREST = TrailSprites.rgb(93, 126, 114)
        val NEAR_FOREST = TrailSprites.rgb(52, 90, 74)
        val FAR_GROUND = TrailSprites.rgb(91, 122, 83)
        val GRASS_A = TrailSprites.rgb(94, 139, 76)
        val GRASS_B = TrailSprites.rgb(83, 127, 69)
        val DIRT_A = TrailSprites.rgb(161, 124, 85)
        val DIRT_B = TrailSprites.rgb(146, 108, 75)
        val DIRT_LIGHT = TrailSprites.rgb(176, 145, 109)
        val DIRT_SHADOW = TrailSprites.rgb(129, 99, 72)
        val RUT = TrailSprites.rgb(103, 76, 56)
        val EDGE = TrailSprites.rgb(109, 93, 71)
        val LIP = TrailSprites.rgb(195, 151, 96)
        val DITCH_DARK = TrailSprites.rgb(35, 27, 24)
        val DITCH_WALL = TrailSprites.rgb(87, 66, 49)
        val TIMING = TrailSprites.rgb(80, 240, 120)
        val CRASH_TEXT = TrailSprites.rgb(236, 170, 150)
        val METER_BACK = TrailSprites.rgb(40, 40, 40)
        val METER_BOOST = TrailSprites.rgb(252, 160, 68)
        val METER_READY = TrailSprites.rgb(0, 200, 90)
        val METER_IDLE = TrailSprites.rgb(110, 110, 110)
        val METER_STEADY = TrailSprites.rgb(60, 140, 200)
        val SIM_BUTTON = TrailSprites.rgb(60, 60, 60) and 0x00FFFFFF or (200 shl 24)
        val WARN_TEXT = TrailSprites.rgb(252, 140, 60)
        val GOOD_TEXT = TrailSprites.rgb(120, 240, 120)
        val PROMPT_TEXT = TrailSprites.rgb(252, 224, 100)
    }
}
