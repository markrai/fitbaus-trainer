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
internal class GhoulSprite(var x: Float, var y: Float, var kind: GhoulSpriteKind, var lift: Float = 0f, var mouthOpen: Float = 0f) {
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
    var mouthOpen = 0f

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
 * through a transposing matrix with filtering off. Industrial panels use stable maze-seeded
 * variation and atmospheric distance fog. Billboards are not rasterised here: [draws] lists each visible sprite's rectangle
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
    private val wallSpans = Array(LEVELS + 1) { Array(FOG_LEVELS + 1) { IntArray(height) } }
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
            val lit = shade(WALL, level.toFloat() / LEVELS)
            for (fogLevel in 0..FOG_LEVELS) {
                val color = blend(lit, GhoulIndustrialArt.FOG_COLOR, fogLevel * MAX_FOG / FOG_LEVELS)
                wallSpans[level][fogLevel].fill(color)
            }
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
        val spans = wallSpans
        val ambient = GhoulDarkness.ambient(lampTiles)
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
            val level = (f * LEVELS).toInt().coerceIn(0, LEVELS)
            val fogLevel = (GhoulIndustrialArt.fog(d, 0.5f) * ambient * FOG_LEVELS / MAX_FOG)
                .toInt().coerceIn(0, FOG_LEVELS)
            val plate = spans[level][fogLevel]
            System.arraycopy(plate, 0, pix, base + y0, y1 - y0 + 1)
            val lineH = half + half
            if (lineH < TEXTURE_MIN_LINE) continue
            val seam = spans[(level * SEAM_SHADE).toInt()][fogLevel]
            val u = wallU[column]
            if (u < JOINT_WIDTH || u > 1f - JOINT_WIDTH) {
                System.arraycopy(seam, 0, pix, base + y0, y1 - y0 + 1)
                continue
            }
            val variant = GhoulIndustrialArt.variant(grid.seed, hits.tileRow[column], hits.tileCol[column], sides[column] + 2)
            if (variant == 2 && (u in 0.24f..0.30f || u in 0.70f..0.76f)) {
                System.arraycopy(seam, 0, pix, base + y0, y1 - y0 + 1)
                continue
            }
            val bands = if (variant == 1) 6 else 3
            val line = max(1, (lineH * if (variant == 1) 0.045f else 0.028f).toInt())
            for (band in 1 until bands) {
                if (variant == 1 && band % 2 != 0) continue
                val start = max(y0, (top + band * lineH / bands).toInt())
                val end = min(y1, start + line - 1)
                if (end >= start) System.arraycopy(seam, 0, pix, base + start, end - start + 1)
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
        val ambient = GhoulDarkness.ambient(lightTiles)
        val horizon = height / 2f + MAX_SHIFT
        val k = 0.5f * focal
        for (py in background.indices) {
            val centre = py + 0.5f
            background[py] = if (centre > horizon) {
                val distance = k / (centre - horizon)
                blend(shade(FLOOR, light(distance)), GhoulIndustrialArt.FOG_COLOR,
                    GhoulIndustrialArt.fog(distance, 0f) * ambient)
            } else {
                val distance = k / (horizon - centre)
                blend(shade(CEILING, light(distance)), GhoulIndustrialArt.FOG_COLOR,
                    GhoulIndustrialArt.fog(distance, 1f) * ambient)
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
            draw.mouthOpen = sprite.mouthOpen
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
        const val MAX_SPRITES = 128
        const val MAX_SHIFT = 12
        const val LEVELS = 64
        const val FOG_LEVELS = 8
        const val MAX_FOG = 0.72f
        const val TEXTURE_MIN_LINE = 24f
        const val JOINT_WIDTH = 0.05f
        const val NEAR_CLIP = 0.15f
        const val PILOT_TILES = 1.6f
        const val PILOT_LEVEL = 0.28f
        const val INV_PILOT = 1f / PILOT_TILES
        const val SIDE_Y_SHADE = 0.68f
        const val SEAM_SHADE = 0.44f

        val FLOOR = rgb(70, 79, 87)
        val CEILING = rgb(41, 49, 57)
        val WALL = rgb(102, 115, 124)

        fun rgb(r: Int, g: Int, b: Int): Int = OPAQUE or (r shl 16) or (g shl 8) or b

        fun falloff(t: Float): Float {
            if (t >= 1f) return 0f
            if (t <= 0f) return 1f
            val s = 1f - t
            return s * s * (3f - 2f * s)
        }

        fun blend(color: Int, fog: Int, weight: Float): Int {
            val k = (weight.coerceIn(0f, 1f) * 256f).toInt()
            val inverse = 256 - k
            val r = (((color shr 16 and 255) * inverse + (fog shr 16 and 255) * k) shr 8)
            val g = (((color shr 8 and 255) * inverse + (fog shr 8 and 255) * k) shr 8)
            val b = (((color and 255) * inverse + (fog and 255) * k) shr 8)
            return rgb(r, g, b)
        }

        fun shade(color: Int, f: Float): Int {
            val k = (f.coerceIn(0f, 1f) * 256f).toInt()
            val r = ((color shr 16) and 0xFF) * k shr 8
            val g = ((color shr 8) and 0xFF) * k shr 8
            val b = (color and 0xFF) * k shr 8
            return OPAQUE or (r shl 16) or (g shl 8) or b
        }

        fun spriteWidth(kind: GhoulSpriteKind): Float = when (kind) {
            GhoulSpriteKind.Ghoul, GhoulSpriteKind.GhoulStunned -> GhoulConceptArt.BILLBOARD_WIDTH
            GhoulSpriteKind.Exit, GhoulSpriteKind.ExitLocked -> 0.7f
            GhoulSpriteKind.ShrineReady, GhoulSpriteKind.ShrineSpent -> 0.3f
        }

        fun spriteHeight(kind: GhoulSpriteKind): Float = when (kind) {
            GhoulSpriteKind.Ghoul, GhoulSpriteKind.GhoulStunned -> GhoulConceptArt.BILLBOARD_HEIGHT
            GhoulSpriteKind.Exit, GhoulSpriteKind.ExitLocked -> 0.92f
            GhoulSpriteKind.ShrineReady, GhoulSpriteKind.ShrineSpent -> 0.85f
        }

        fun spriteBase(kind: GhoulSpriteKind): Float = when (kind) {
            GhoulSpriteKind.Ghoul, GhoulSpriteKind.GhoulStunned -> GhoulConceptArt.BILLBOARD_BASE
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

/** Procedural fallback artwork retained only for exit and shrine props. */
internal object GhoulSpriteArt {
    private val EXIT_GREEN = GhoulFirstPersonRenderer.rgb(80, 232, 118)
    private val EXIT_FRAME = GhoulFirstPersonRenderer.rgb(36, 140, 62)
    private val EXIT_LOCKED = GhoulFirstPersonRenderer.rgb(115, 45, 48)
    private val SHRINE_READY = GhoulFirstPersonRenderer.rgb(70, 225, 230)
    private val SHRINE_SPENT = GhoulFirstPersonRenderer.rgb(35, 67, 72)

    fun texture(kind: GhoulSpriteKind, w: Int, h: Int): IntArray {
        require(kind != GhoulSpriteKind.Ghoul && kind != GhoulSpriteKind.GhoulStunned)
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

    fun textureHeight(@Suppress("UNUSED_PARAMETER") kind: GhoulSpriteKind): Int = 56
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
