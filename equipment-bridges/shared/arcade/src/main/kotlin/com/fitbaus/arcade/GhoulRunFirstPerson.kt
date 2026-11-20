// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.tan

internal enum class GhoulSpriteKind { Ghoul, GhoulStunned, Exit, ExitLocked, ShrineReady, ShrineSpent }

/** A billboard in continuous tile space; [lift] raises it off the floor in wall heights. */
internal class GhoulSprite(var x: Float, var y: Float, var kind: GhoulSpriteKind, var lift: Float = 0f) {
    internal var depth = 0f
}

/**
 * Eases the first-person camera through GHOUL RUN's graph movement. Position follows the rider
 * along its edge exactly; yaw never snaps: a 90 degree turn eases over [turnSeconds], starting
 * half of that before the junction (at current speed, never earlier than the choice lock), and a
 * dead-end turnaround rotates 180 degrees over the game's turnaround time. Only a teleport
 * (respawn, restart) snaps, and those happen behind a fade.
 */
internal class GhoulCameraRig(private val turnSeconds: Float = 0.35f) {
    var x: Float = 0f
        private set
    var y: Float = 0f
        private set
    var yaw: Float = 0f
        private set
    private var target = Float.NaN
    private var fromYaw = 0f
    private var toYaw = 0f
    private var animT = 0f
    private var animDuration = 0f

    fun update(game: GhoulRunGame, dt: Float) {
        val nx = GhoulRaycaster.cellX(game.riderCol)
        val ny = GhoulRaycaster.cellY(game.riderRow)
        val wanted = targetYaw(game)
        if (target.isNaN() || hypot(nx - x, ny - y) > TELEPORT_TILES) {
            x = nx
            y = ny
            snap(wanted)
            return
        }
        x = nx
        y = ny
        if (angleBetween(wanted, target) > 0.001f) {
            target = wanted
            fromYaw = yaw
            val delta = shortestDelta(yaw, wanted)
            toYaw = yaw + delta
            animT = 0f
            // Constant angular pace: back-to-back turns that chain before the last ease ends take longer, not faster.
            animDuration = if (game.turningLeft > 0f) {
                game.config.deadEndTurnSeconds
            } else {
                max(MIN_EASE_SECONDS, turnSeconds * abs(delta) / HALF_PI)
            }
        }
        if (animT < animDuration) {
            animT = min(animDuration, animT + dt)
            val s = animT / animDuration
            yaw = fromYaw + (toYaw - fromYaw) * s * s * (3f - 2f * s)
        } else {
            yaw = toYaw
        }
    }

    fun snap(yawValue: Float) {
        target = yawValue
        yaw = yawValue
        fromYaw = yawValue
        toYaw = yawValue
        animT = 0f
        animDuration = 0f
    }

    fun reset() {
        target = Float.NaN
    }

    private fun targetYaw(game: GhoulRunGame): Float {
        if (game.turningLeft > 0f) return GhoulRaycaster.yawOf(game.heading.opposite)
        val heading = game.heading
        if (game.phase == GhoulPhase.Playing && game.world.isOpen(game.riderCell, heading)) {
            val choice = game.activeChoice
            val window = min(max(game.speed, 0f) * turnSeconds / 2f, game.config.junctionLockDistance)
            if (choice != null && choice != heading && choice != heading.opposite && 1f - game.progress <= window) {
                return GhoulRaycaster.yawOf(choice)
            }
        }
        return GhoulRaycaster.yawOf(heading)
    }

    private companion object {
        const val TELEPORT_TILES = 1.5f
        const val TWO_PI = (2.0 * PI).toFloat()
        const val HALF_PI = (PI / 2.0).toFloat()
        const val MIN_EASE_SECONDS = 0.12f

        /** Shortest signed rotation; an exact reversal always turns the same (clockwise) way. */
        fun shortestDelta(from: Float, to: Float): Float {
            var d = (to - from) % TWO_PI
            if (d > PI) d -= TWO_PI
            if (d < -PI) d += TWO_PI
            if (abs(abs(d) - PI.toFloat()) < 0.01f) d = PI.toFloat()
            return d
        }

        fun angleBetween(a: Float, b: Float): Float = abs(shortestDelta(a, b))
    }
}

/** Screen placement of one visible billboard, in low-res frame pixels, clipped to visible column runs. */
internal class GhoulSpriteDraw {
    var kind: GhoulSpriteKind = GhoulSpriteKind.Exit
    var left = 0f
    var top = 0f
    var width = 0f
    var height = 0f

    /** Lamp level 0..1 (already including any glow) the view applies as a multiply filter. */
    var light = 1f

    /** Inclusive [start, end] column pairs where the sprite is in front of the wall. */
    val runs = IntArray(MAX_RUNS * 2)
    var runCount = 0

    internal companion object {
        const val MAX_RUNS = 8
    }
}

/**
 * Wolfenstein-style first-person renderer for a low-res frame. Pure Kotlin, but shaped for the
 * console's interpreted ART: [pixels] is COLUMN-MAJOR (pixel (x, y) at `x * height + y`) so each
 * column is one contiguous run filled with a handful of `System.arraycopy` calls from prebuilt
 * shade spans, never a per-pixel loop. The view uploads it as a transposed bitmap and draws it
 * through a transposing matrix with filtering off. Walls, floor and ceiling fade to black at the
 * lamp radius. Billboards are not rasterised here: [draws] lists each visible sprite's rectangle
 * and the column runs where it beats the per-column depth buffer, far to near.
 */
internal class GhoulFirstPersonRenderer(val width: Int, val height: Int, fovDegrees: Float = 70f) {
    val pixels = IntArray(width * height)
    val hits = GhoulRayHits(width)
    val fovRadians: Float = (fovDegrees * PI / 180.0).toFloat()
    val focal: Float = (width / 2f) / tan(fovRadians / 2f)
    val draws = Array(MAX_SPRITES) { GhoulSpriteDraw() }
    var drawCount = 0
        private set
    /** Floor/ceiling shades for a horizon at the centre, padded so head bob can shift it. */
    private val background = IntArray(height + 2 * MAX_SHIFT)
    private var backgroundLamp = Int.MIN_VALUE
    private val brickSpans = Array(LEVELS + 1) { IntArray(height) }
    private val order = ArrayList<GhoulSprite>()
    private var lightTiles = 1f

    /** Last frame's stage timings, for the diagnostics overlay. */
    var castNanos = 0L
        private set
    var columnNanos = 0L
        private set
    var spriteNanos = 0L
        private set

    init {
        require(width > 0 && height > 0)
        for (level in 0..LEVELS) {
            val color = shade(WALL, level.toFloat() / LEVELS)
            val span = brickSpans[level]
            for (y in 0 until height) span[y] = color
        }
    }

    /**
     * @param eye eye height in wall heights (0.5 = middle of the wall; head bob nudges it).
     * @param lampTiles lamp radius in tiles (cells x 2); a dim pilot glow keeps adjacent walls faintly visible.
     */
    fun render(
        grid: GhoulRayGrid,
        camX: Float,
        camY: Float,
        yaw: Float,
        eye: Float,
        lampTiles: Float,
        sprites: List<GhoulSprite>,
        timeSeconds: Float,
    ) {
        lightTiles = lampTiles
        val started = System.nanoTime()
        GhoulRaycaster.castView(grid, camX, camY, yaw, fovRadians, hits)
        val cast = System.nanoTime()
        val h = height
        // Head bob and shake move the horizon (a pitch), so the shade column only depends on the lamp.
        val shift = ((eye - 0.5f) * focal).toInt().coerceIn(-MAX_SHIFT, MAX_SHIFT)
        val horizon = h / 2f + shift
        val lampKey = (lampTiles * 32f).toInt()
        if (lampKey != backgroundLamp) {
            backgroundLamp = lampKey
            fillBackground()
        }
        val invLamp = if (lampTiles > 0f) 1f / lampTiles else 0f
        val distance = hits.distance
        val sides = hits.side
        val wallU = hits.wallU
        val pix = pixels
        val bg = background
        val bgStart = MAX_SHIFT - shift
        val spans = brickSpans
        val halfFocal = 0.5f * focal
        for (column in 0 until width) {
            val base = column * h
            System.arraycopy(bg, bgStart, pix, base, h)
            val d = distance[column]
            val half = halfFocal / d
            val top = horizon - half
            val y0 = max(0, ceil(top - 0.5f).toInt())
            val y1 = min(h - 1, (horizon + half - 0.5f).toInt())
            if (y1 < y0) continue
            // Inlined light(d): calls are costly on the console's interpreted runtime.
            var t = d * invLamp
            var f = if (t >= 1f || invLamp == 0f) 0f else { val k = 1f - t; k * k * (3f - 2f * k) }
            t = d * INV_PILOT
            if (t < 1f) {
                val k = 1f - t
                val pilot = PILOT_LEVEL * k * k * (3f - 2f * k)
                if (pilot > f) f = pilot
            }
            if (sides[column] != GhoulRaycaster.SIDE_X) f *= SIDE_Y_SHADE
            val level = (f * LEVELS).toInt()
            val brick = spans[level]
            val lineH = half + half
            System.arraycopy(brick, 0, pix, base + y0, y1 - y0 + 1)
            if (lineH < TEXTURE_MIN_LINE) continue
            // Brick texture with few native copies: three mortar lines, plus vertical joints only where u says so.
            val mortar = spans[(level * MORTAR_SHADE).toInt()]
            val bandH = lineH / BANDS
            val line = max(1, (lineH * 0.06f).toInt())
            for (band in 1 until BANDS) {
                var s = (top + band * bandH).toInt()
                val e = min(y1, s + line - 1)
                if (s < y0) s = y0
                if (e >= s) System.arraycopy(mortar, 0, pix, base + s, e - s + 1)
            }
            val u = wallU[column]
            val first = when {
                u < JOINT_WIDTH -> 0
                u >= 0.5f && u < 0.5f + JOINT_WIDTH -> 1
                else -> continue
            }
            var band = first
            while (band < BANDS) {
                var s = (top + band * bandH).toInt()
                val e = min(y1, (top + (band + 1) * bandH).toInt() - 1)
                if (s < y0) s = y0
                if (e >= s) System.arraycopy(mortar, 0, pix, base + s, e - s + 1)
                band += 2
            }
        }
        val columns = System.nanoTime()
        placeSprites(camX, camY, yaw, horizon, sprites, timeSeconds)
        val done = System.nanoTime()
        castNanos = cast - started
        columnNanos = columns - cast
        spriteNanos = done - columns
    }

    private fun fillBackground() {
        val horizon = height / 2f + MAX_SHIFT
        val k = 0.5f * focal
        for (py in background.indices) {
            val centre = py + 0.5f
            background[py] = if (centre > horizon) {
                shade(FLOOR, light(k / (centre - horizon)))
            } else {
                shade(CEILING, light(k / (horizon - centre)))
            }
        }
    }

    /** Colour at low-res frame pixel (x, y), for tests and probes. */
    fun pixelAt(x: Int, y: Int): Int = pixels[x * height + y]

    private fun placeSprites(
        camX: Float,
        camY: Float,
        yaw: Float,
        horizon: Float,
        sprites: List<GhoulSprite>,
        time: Float,
    ) {
        drawCount = 0
        val dirX = cos(yaw)
        val dirY = sin(yaw)
        val k = tan(fovRadians / 2f)
        val planeX = -dirY * k
        val planeY = dirX * k
        val invDet = 1f / (planeX * dirY - dirX * planeY)
        order.clear()
        for (sprite in sprites) {
            val rx = sprite.x - camX
            val ry = sprite.y - camY
            sprite.depth = invDet * (-planeY * rx + planeX * ry)
            if (sprite.depth > NEAR_CLIP) order += sprite
        }
        if (order.size > 1) order.sortByDescending { it.depth }
        val distance = hits.distance
        for (sprite in order) {
            if (drawCount == MAX_SPRITES) break
            val depth = sprite.depth
            val lateral = invDet * (dirY * (sprite.x - camX) - dirX * (sprite.y - camY))
            val screenX = (width / 2f) * (1f + lateral / depth)
            val kind = sprite.kind
            val worldW = spriteWidth(kind)
            val worldH = spriteHeight(kind)
            val z0 = spriteBase(kind) + sprite.lift
            val sw = focal * worldW / depth
            val sh = focal * worldH / depth
            val top = horizon + (0.5f - (z0 + worldH)) * focal / depth
            val left = screenX - sw / 2f
            val x0 = max(0, (left + 0.5f).toInt())
            val x1 = min(width - 1, (left + sw - 0.5f).toInt())
            if (x1 < x0 || top > height || top + sh < 0f) continue
            val draw = draws[drawCount]
            draw.runCount = 0
            var runStart = -1
            for (column in x0..x1) {
                val visible = depth < distance[column]
                if (visible && runStart < 0) runStart = column
                if (!visible && runStart >= 0) {
                    addRun(draw, runStart, column - 1)
                    runStart = -1
                }
            }
            if (runStart >= 0) addRun(draw, runStart, x1)
            if (draw.runCount == 0) continue
            draw.kind = kind
            draw.left = left
            draw.top = top
            draw.width = sw
            draw.height = sh
            draw.light = max(light(depth), spriteGlow(kind, time))
            drawCount += 1
        }
    }

    private fun addRun(draw: GhoulSpriteDraw, start: Int, end: Int) {
        if (draw.runCount == GhoulSpriteDraw.MAX_RUNS) {
            draw.runs[draw.runCount * 2 - 1] = end
            return
        }
        draw.runs[draw.runCount * 2] = start
        draw.runs[draw.runCount * 2 + 1] = end
        draw.runCount += 1
    }

    /** Lamp falloff to black at [lightTiles], plus a dim pilot glow so a stopped rider is not blind. */
    fun light(distance: Float): Float {
        val lamp = if (lightTiles > 0f) falloff(distance / lightTiles) else 0f
        return max(lamp, PILOT_LEVEL * falloff(distance / PILOT_TILES))
    }

    internal companion object {
        const val OPAQUE = -0x1000000
        const val MAX_SPRITES = 12
        const val MAX_SHIFT = 12
        const val LEVELS = 64
        const val BANDS = 4
        const val TEXTURE_MIN_LINE = 24f
        const val JOINT_WIDTH = 0.04f
        const val NEAR_CLIP = 0.15f
        const val PILOT_TILES = 1.6f
        const val PILOT_LEVEL = 0.28f
        const val INV_PILOT = 1f / PILOT_TILES
        const val SIDE_Y_SHADE = 0.68f
        const val MORTAR_SHADE = 0.72f

        val FLOOR = rgb(74, 66, 58)
        val CEILING = rgb(30, 32, 40)
        val WALL = rgb(150, 146, 138)

        fun rgb(r: Int, g: Int, b: Int): Int = OPAQUE or (r shl 16) or (g shl 8) or b

        fun falloff(t: Float): Float {
            if (t >= 1f) return 0f
            if (t <= 0f) return 1f
            val s = 1f - t
            return s * s * (3f - 2f * s)
        }

        fun shade(color: Int, f: Float): Int {
            val k = (f.coerceIn(0f, 1f) * 256f).toInt()
            val r = ((color shr 16) and 0xFF) * k shr 8
            val g = ((color shr 8) and 0xFF) * k shr 8
            val b = (color and 0xFF) * k shr 8
            return OPAQUE or (r shl 16) or (g shl 8) or b
        }

        fun spriteWidth(kind: GhoulSpriteKind): Float = when (kind) {
            GhoulSpriteKind.Ghoul, GhoulSpriteKind.GhoulStunned -> 1.25f
            GhoulSpriteKind.Exit, GhoulSpriteKind.ExitLocked -> 0.7f
            GhoulSpriteKind.ShrineReady, GhoulSpriteKind.ShrineSpent -> 0.3f
        }

        fun spriteHeight(kind: GhoulSpriteKind): Float = when (kind) {
            GhoulSpriteKind.Ghoul, GhoulSpriteKind.GhoulStunned -> 1f
            GhoulSpriteKind.Exit, GhoulSpriteKind.ExitLocked -> 0.92f
            GhoulSpriteKind.ShrineReady, GhoulSpriteKind.ShrineSpent -> 0.85f
        }

        fun spriteBase(kind: GhoulSpriteKind): Float = when (kind) {
            GhoulSpriteKind.Ghoul, GhoulSpriteKind.GhoulStunned -> 0f
            else -> 0f
        }

        fun spriteGlow(kind: GhoulSpriteKind, time: Float): Float = when (kind) {
            GhoulSpriteKind.Exit -> 0.5f
            GhoulSpriteKind.ShrineReady -> 0.42f + 0.12f * sin(time * 4f)
            GhoulSpriteKind.ShrineSpent -> 0.15f
            GhoulSpriteKind.Ghoul -> 0.12f
            else -> 0f
        }
    }
}

/**
 * Billboard artwork, rasterised once into small row-major ARGB textures (0 = transparent) so the
 * view can scale them with Canvas instead of shading per pixel. The ghoul has [GHOUL_FRAMES]
 * animation frames and a separate always-lit eyes layer.
 */
internal object GhoulSpriteArt {
    const val GHOUL_FRAMES = 4
    const val FRAME_SECONDS = 0.18f

    private const val BRANCHES = 44

    // The ghoul stays red (one colour, one meaning); the eyes glow hot so they read in the dark.
    private val HEAD = GhoulFirstPersonRenderer.rgb(232, 120, 108)
    private val FACE = GhoulFirstPersonRenderer.rgb(196, 84, 76)
    private val SOCKET = GhoulFirstPersonRenderer.rgb(40, 6, 8)
    private val NECK = GhoulFirstPersonRenderer.rgb(186, 70, 64)
    private val STRANDS = GhoulFirstPersonRenderer.rgb(240, 150, 140)
    private val CHEST = GhoulFirstPersonRenderer.rgb(176, 58, 54)
    private val SHOULDER = GhoulFirstPersonRenderer.rgb(196, 76, 70)
    private val RAGS = GhoulFirstPersonRenderer.rgb(118, 20, 24)
    private val RAGS_DARK = GhoulFirstPersonRenderer.rgb(86, 12, 16)
    private val ARM = GhoulFirstPersonRenderer.rgb(170, 52, 50)
    private val FOREARM = GhoulFirstPersonRenderer.rgb(150, 36, 38)
    private val CLAW = GhoulFirstPersonRenderer.rgb(222, 70, 60)
    private val LEG = GhoulFirstPersonRenderer.rgb(100, 16, 20)
    private val LEG_DARK = GhoulFirstPersonRenderer.rgb(78, 10, 14)
    private val FOOT = GhoulFirstPersonRenderer.rgb(60, 8, 10)
    private val BRANCH_DARK = GhoulFirstPersonRenderer.rgb(128, 22, 26)
    private val BRANCH_LIGHT = GhoulFirstPersonRenderer.rgb(172, 40, 40)
    private val WEB = GhoulFirstPersonRenderer.rgb(180, 92, 88)
    private val EYE_GLOW = GhoulFirstPersonRenderer.rgb(255, 150, 60)
    private val EYE_CORE = GhoulFirstPersonRenderer.rgb(255, 238, 200)
    private val EXIT_GREEN = GhoulFirstPersonRenderer.rgb(80, 232, 118)
    private val EXIT_FRAME = GhoulFirstPersonRenderer.rgb(36, 140, 62)
    private val EXIT_LOCKED = GhoulFirstPersonRenderer.rgb(115, 45, 48)
    private val SHRINE_READY = GhoulFirstPersonRenderer.rgb(70, 225, 230)
    private val SHRINE_SPENT = GhoulFirstPersonRenderer.rgb(35, 67, 72)

    fun texture(kind: GhoulSpriteKind, w: Int, h: Int, frame: Int = 0, eyesOnly: Boolean = false): IntArray {
        when (kind) {
            GhoulSpriteKind.Ghoul -> return ghoul(w, h, frame, stunned = false, eyesOnly = eyesOnly)
            GhoulSpriteKind.GhoulStunned -> return ghoul(w, h, frame, stunned = true, eyesOnly = eyesOnly)
            else -> Unit
        }
        val out = IntArray(w * h)
        for (y in 0 until h) for (x in 0 until w) {
            val u = (x + 0.5f) / w
            val v = (y + 0.5f) / h
            out[y * w + x] = when (kind) {
                GhoulSpriteKind.Exit -> door(u, v, locked = false)
                GhoulSpriteKind.ExitLocked -> door(u, v, locked = true)
                GhoulSpriteKind.ShrineReady -> pillar(u, v, SHRINE_READY)
                GhoulSpriteKind.ShrineSpent -> pillar(u, v, SHRINE_SPENT)
                else -> 0
            }
        }
        return out
    }

    /** Texture height in pixels; the ghoul gets more detail than the props. */
    fun textureHeight(kind: GhoulSpriteKind): Int = when (kind) {
        GhoulSpriteKind.Ghoul, GhoulSpriteKind.GhoulStunned -> 128
        else -> 56
    }

    /**
     * A gaunt, bald, long-armed figure in rags with a halo of thorny branches radiating from its
     * back, all in reds, with glowing eyes on a separate always-lit layer. Rasterised by stamping
     * discs along strokes (cost scales with drawn pixels, which matters on the interpreted console).
     * Coordinates are in units of the texture height, x centred. The layout is seeded, so every
     * frame is the same creature; frames only sway the branches.
     */
    private fun ghoul(w: Int, h: Int, frame: Int, stunned: Boolean, eyesOnly: Boolean): IntArray {
        val r = Raster(w, h)
        if (eyesOnly) {
            if (!stunned) {
                for (side in intArrayOf(-1, 1)) {
                    r.disc(side * 0.021f, 0.118f, 0.0105f, EYE_GLOW)
                    r.disc(side * 0.021f, 0.117f, 0.005f, EYE_CORE)
                }
            }
            return r.px
        }
        val rng = kotlin.random.Random(0x6807)
        val sway = frame * (PI.toFloat() / 2f)
        // Thorn halo, behind the body.
        for (i in 0 until BRANCHES) {
            var angle = rng.nextFloat() * 2f * PI.toFloat() - PI.toFloat()
            if (sin(angle) > 0.82f) angle += if (cos(angle) >= 0f) -0.9f else 0.9f
            val sideways = abs(cos(angle))
            val length = (0.22f + rng.nextFloat() * 0.3f) * (1f + 0.45f * sideways)
            var x = (rng.nextFloat() - 0.5f) * 0.08f
            var y = 0.22f + rng.nextFloat() * 0.22f
            var a = angle + 0.05f * sin(sway + i)
            var radius = 0.0125f
            val color = if (i % 3 == 0) BRANCH_LIGHT else BRANCH_DARK
            for (segment in 0 until 3) {
                a += (rng.nextFloat() - 0.5f) * 0.5f
                val step = length / 3f
                val nx = x + cos(a) * step
                val ny = y + sin(a) * step
                val nr = radius * 0.6f
                r.line(x, y, nx, ny, radius, nr, color)
                if (rng.nextFloat() < 0.55f) {
                    val ta = a + (if (rng.nextBoolean()) 0.65f else -0.65f) + 0.08f * sin(sway + i * 2)
                    val tl = 0.05f + rng.nextFloat() * 0.07f
                    r.line(nx, ny, nx + cos(ta) * tl, ny + sin(ta) * tl, nr * 0.8f, 0.0015f, color)
                }
                x = nx
                y = ny
                radius = nr
            }
        }
        // Cobweb strands between the inner branches.
        repeat(5) {
            val a0 = rng.nextFloat() * 2f * PI.toFloat()
            val a1 = a0 + 0.5f + rng.nextFloat() * 0.5f
            val d0 = 0.12f + rng.nextFloat() * 0.12f
            val d1 = d0 + (rng.nextFloat() - 0.5f) * 0.06f
            r.line(cos(a0) * d0, 0.32f + sin(a0) * d0, cos(a1) * d1, 0.32f + sin(a1) * d1, 0.0018f, 0.0018f, WEB)
        }
        // Legs and feet.
        for (side in intArrayOf(-1, 1)) {
            r.line(side * 0.026f, 0.47f, side * 0.03f, 0.72f, 0.025f, 0.019f, LEG)
            r.line(side * 0.03f, 0.72f, side * 0.031f, 0.94f, 0.019f, 0.014f, LEG_DARK)
            r.ellipse(side * 0.038f, 0.955f, 0.032f, 0.016f, FOOT, 0f)
        }
        // Torso in rags, shoulders, hanging strips, long arms ending in claws.
        r.line(0f, 0.22f, 0f, 0.47f, 0.058f, 0.036f, RAGS)
        r.line(0f, 0.22f, 0f, 0.31f, 0.034f, 0.026f, CHEST)
        for (side in intArrayOf(-1, 1)) {
            r.disc(side * 0.06f, 0.232f, 0.024f, SHOULDER)
            r.line(side * 0.028f, 0.46f, side * 0.042f, 0.57f, 0.012f, 0.006f, RAGS_DARK)
            r.line(side * 0.066f, 0.24f, side * 0.082f, 0.40f, 0.015f, 0.011f, ARM)
            r.line(side * 0.082f, 0.40f, side * 0.088f, 0.555f, 0.011f, 0.008f, FOREARM)
            for (claw in 0 until 4) {
                val cx = side * (0.072f + claw * 0.011f)
                r.line(side * 0.088f, 0.555f, cx, 0.625f + (claw % 2) * 0.012f, 0.005f, 0.0015f, CLAW)
            }
        }
        // Neck, bald elongated head, hollow eye sockets, stringy jaw.
        r.line(0f, 0.165f, 0f, 0.215f, 0.016f, 0.018f, NECK)
        r.ellipse(0f, 0.088f, 0.056f, 0.06f, HEAD, 0.4f)
        r.ellipse(0f, 0.125f, 0.044f, 0.055f, HEAD, 0.4f)
        r.ellipse(0f, 0.152f, 0.03f, 0.03f, FACE, 0.25f)
        for (side in intArrayOf(-1, 1)) r.ellipse(side * 0.021f, 0.118f, 0.015f, 0.011f, SOCKET, 0f)
        for (strand in -2..2) {
            r.line(strand * 0.009f, 0.165f, strand * 0.02f, 0.255f + abs(strand) * 0.01f, 0.0028f, 0.0015f, STRANDS)
        }
        if (stunned) {
            for (i in r.px.indices) {
                val c = r.px[i]
                if (c == 0) continue
                val grey = (((c shr 16) and 0xFF) * 3 + ((c shr 8) and 0xFF) * 6 + (c and 0xFF)) / 10
                val g = 70 + grey * 6 / 10
                r.px[i] = GhoulFirstPersonRenderer.OPAQUE or (g shl 16) or (g shl 8) or min(255, g + 6)
            }
        }
        return r.px
    }

    /** Minimal pure rasteriser: discs, tapered strokes and shaded ellipses in height units, x centred. */
    private class Raster(val w: Int, val h: Int) {
        val px = IntArray(w * h)
        private val scale = h.toFloat()
        private val centre = w / 2f

        fun disc(fx: Float, fy: Float, fr: Float, color: Int) {
            val cx = centre + fx * scale
            val cy = fy * scale
            val radius = max(0.5f, fr * scale)
            val r2 = radius * radius
            val x0 = max(0, (cx - radius).toInt())
            val x1 = min(w - 1, (cx + radius).toInt())
            val y0 = max(0, (cy - radius).toInt())
            val y1 = min(h - 1, (cy + radius).toInt())
            for (y in y0..y1) {
                val dy = y + 0.5f - cy
                for (x in x0..x1) {
                    val dx = x + 0.5f - cx
                    if (dx * dx + dy * dy <= r2) px[y * w + x] = color
                }
            }
        }

        fun line(fx0: Float, fy0: Float, fx1: Float, fy1: Float, r0: Float, r1: Float, color: Int) {
            val length = kotlin.math.hypot(fx1 - fx0, fy1 - fy0) * scale
            val steps = max(1, (length / 0.6f).toInt())
            for (i in 0..steps) {
                val t = i.toFloat() / steps
                disc(fx0 + (fx1 - fx0) * t, fy0 + (fy1 - fy0) * t, r0 + (r1 - r0) * t, color)
            }
        }

        /** Filled ellipse, lit from the upper left by [relief] (0 = flat). */
        fun ellipse(fx: Float, fy: Float, frx: Float, fry: Float, color: Int, relief: Float) {
            val cx = centre + fx * scale
            val cy = fy * scale
            val rx = max(0.5f, frx * scale)
            val ry = max(0.5f, fry * scale)
            val x0 = max(0, (cx - rx).toInt())
            val x1 = min(w - 1, (cx + rx).toInt())
            val y0 = max(0, (cy - ry).toInt())
            val y1 = min(h - 1, (cy + ry).toInt())
            for (y in y0..y1) {
                val ny = (y + 0.5f - cy) / ry
                for (x in x0..x1) {
                    val nx = (x + 0.5f - cx) / rx
                    val d = nx * nx + ny * ny
                    if (d > 1f) continue
                    px[y * w + x] = if (relief == 0f) color else shadeRaw(color, 1f - relief * (0.35f * (nx + ny) + 0.45f * d))
                }
            }
        }
    }

    private fun door(u: Float, v: Float, locked: Boolean): Int {
        val frame = u < 0.12f || u > 0.88f || v < 0.1f
        return when {
            frame -> if (locked) EXIT_LOCKED else EXIT_FRAME
            locked -> 0
            else -> shadeRaw(EXIT_GREEN, 0.7f + 0.3f * v)
        }
    }

    private fun pillar(u: Float, v: Float, color: Int): Int {
        val du = abs(u - 0.5f)
        return when {
            v < 0.12f -> shadeRaw(color, 1.1f)
            v > 0.92f -> shadeRaw(color, 0.8f)
            du < 0.1f -> shadeRaw(color, 1.25f)
            du < 0.32f -> shadeRaw(color, 0.85f)
            else -> 0
        }
    }

    private fun shadeRaw(color: Int, f: Float): Int {
        val k = (f.coerceIn(0f, 2f) * 256f).toInt()
        val r = min(255, ((color shr 16) and 0xFF) * k shr 8)
        val g = min(255, ((color shr 8) and 0xFF) * k shr 8)
        val b = min(255, (color and 0xFF) * k shr 8)
        return GhoulFirstPersonRenderer.OPAQUE or (r shl 16) or (g shl 8) or b
    }
}
