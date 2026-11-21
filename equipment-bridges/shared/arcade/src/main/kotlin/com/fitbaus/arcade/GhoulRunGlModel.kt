// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.math.tan

internal data class GhoulUv(val u: Float, val v: Float)

internal data class GhoulAnchor(
    val canvasWidth: Int,
    val canvasHeight: Int,
    val chest: GhoulUv,
    val feet: GhoulUv,
)

/** Small strict parser for the committed anchor file; avoids an Android JSON dependency in pure tests. */
internal object GhoulAnchorParser {
    fun parse(json: String): GhoulAnchor {
        val canvas = intPair(json, "canvas")
        val chest = floatPair(json, "chest")
        val feet = floatPair(json, "feet")
        require(canvas.first > 0 && canvas.second > 0)
        require(chest.first in 0f..1f && chest.second in 0f..1f)
        require(feet.first in 0f..1f && feet.second in 0f..1f)
        return GhoulAnchor(canvas.first, canvas.second, GhoulUv(chest.first, chest.second), GhoulUv(feet.first, feet.second))
    }

    private fun intPair(json: String, name: String): Pair<Int, Int> {
        val values = pair(json, name)
        return values.first.toInt() to values.second.toInt()
    }

    private fun floatPair(json: String, name: String): Pair<Float, Float> = pair(json, name)

    private fun pair(json: String, name: String): Pair<Float, Float> {
        val number = "[-+]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)"
        val match = Regex("\\\"${Regex.escape(name)}\\\"\\s*:\\s*\\[\\s*($number)\\s*,\\s*($number)\\s*]").find(json)
            ?: throw IllegalArgumentException("missing $name anchor")
        return match.groupValues[1].toFloat() to match.groupValues[2].toFloat()
    }
}

/** CPU mirror of the approved halo shader warp. */
internal fun haloWarp(
    uv: GhoulUv,
    phaseA: Float,
    phaseB: Float,
    flare: Float,
    chest: GhoulUv = GhoulConceptArt.CHEST,
): GhoulUv {
    val dx = (uv.u - chest.u) * GhoulConceptArt.ASPECT
    val dy = uv.v - chest.v
    val r = hypot(dx, dy) / GhoulConceptArt.HALO_RADIUS
    val theta = atan2(dy, dx + 1e-5f)
    val w = smoothstep(0.08f, 0.9f, r) * r
    val tang = 0.0176f * w * sin(phaseA + theta * 3f + r * 4f)
    val radial = 0.0088f * w * sin(phaseB + theta * 5f - r * 6f)
    val scale = 1f + 0.14f * flare * smoothstep(0.3f, 1f, r)
    val tangentX = -sin(theta)
    val tangentY = cos(theta)
    val radialX = cos(theta)
    val radialY = sin(theta)
    val warpedX = dx / scale - (tangentX * tang + radialX * radial)
    val warpedY = dy / scale - (tangentY * tang + radialY * radial)
    return GhoulUv(chest.u + warpedX / GhoulConceptArt.ASPECT, chest.v + warpedY)
}

private fun smoothstep(edge0: Float, edge1: Float, value: Float): Float {
    val t = ((value - edge0) / (edge1 - edge0)).coerceIn(0f, 1f)
    return t * t * (3f - 2f * t)
}

internal object GhoulConceptArt {
    const val ASPECT = 2f
    const val BILLBOARD_HEIGHT = 0.98f
    const val BILLBOARD_WIDTH = ASPECT * BILLBOARD_HEIGHT
    const val FEET_V = 0.9901f
    const val HALO_RADIUS = 0.586f
    const val BOB_AMPLITUDE = 0.006f
    const val FLARE_TIME_CONSTANT = 0.35f
    const val CATCH_FLARE = 1.2f
    const val TINT_RED = 1f
    const val TINT_GREEN = 0.28f
    const val TINT_BLUE = 0.22f
    val CHEST = GhoulUv(0.5094f, 0.3173f)
    val BILLBOARD_BASE = -(1f - FEET_V) * BILLBOARD_HEIGHT
}

/** Pure concept-art animation state. All shader phases stay bounded and never use raw uptime. */
internal class GhoulConceptMotion {
    var phaseA = 0f
        private set
    var phaseB = 0f
        private set
    var flare = 0f
        private set
    private var bobPhase = 0f
    private var swayPhase = 0f

    val bob: Float get() = GhoulConceptArt.BOB_AMPLITUDE * sin(bobPhase)
    val sway: Float get() = SWAY_RADIANS * sin(swayPhase)

    fun advance(dt: Float, state: GhoulState) {
        if (!dt.isFinite() || dt <= 0f) return
        var rateA = 0f
        var rateB = 0f
        when (state) {
            GhoulState.Wandering -> { rateA = 1.2f; rateB = 0.8f }
            GhoulState.Hunting -> { rateA = 2.1f; rateB = 1.3f }
            GhoulState.Searching -> { rateA = 1.6f; rateB = 1f }
            GhoulState.Inactive, GhoulState.Stunned -> Unit
        }
        phaseA = wrapPhase(phaseA + dt * rateA)
        phaseB = wrapPhase(phaseB + dt * rateB)
        bobPhase = wrapPhase(bobPhase + dt * BOB_RADIANS_PER_SECOND)
        swayPhase = wrapPhase(swayPhase + dt * SWAY_RADIANS_PER_SECOND)
        val target = when (state) {
            GhoulState.Hunting -> 1f
            GhoulState.Searching -> 0.35f
            else -> 0f
        }
        val ease = 1f - exp(-dt / GhoulConceptArt.FLARE_TIME_CONSTANT)
        flare += (target - flare) * ease
    }

    fun spikeCatch() {
        flare = maxOf(flare, GhoulConceptArt.CATCH_FLARE)
    }

    fun desaturation(state: GhoulState): Float = if (state == GhoulState.Stunned) 0.8f else 0f

    private fun wrapPhase(value: Float): Float {
        val phase = value % GhoulShaderPhases.TWO_PI
        return if (phase < 0f) phase + GhoulShaderPhases.TWO_PI else phase
    }

    private companion object {
        const val BOB_RADIANS_PER_SECOND = (2.0 * PI * 0.7).toFloat()
        const val SWAY_RADIANS_PER_SECOND = 1.6f
        const val SWAY_RADIANS = (1.2 * PI / 180.0).toFloat()
    }
}

/** Bounded shader phases; shaders never receive large uptime-derived values. */
internal class GhoulShaderPhases {
    var lamp = 0f
        private set
    var glow = 0f
        private set

    fun advance(dt: Float, cadenceHz: Float) {
        if (!dt.isFinite() || dt <= 0f) return
        val cadence = if (cadenceHz.isFinite()) cadenceHz.coerceAtLeast(0f) else 0f
        lamp = wrap(lamp + dt * (LAMP_BASE_RADIANS_PER_SECOND + cadence * LAMP_CADENCE_RADIANS_PER_SECOND))
        glow = wrap(glow + dt * GLOW_RADIANS_PER_SECOND)
    }

    private fun wrap(value: Float): Float {
        val phase = value % TWO_PI
        return if (phase < 0f) phase + TWO_PI else phase
    }

    companion object {
        const val LAMP_BASE_RADIANS_PER_SECOND = 7f
        const val LAMP_CADENCE_RADIANS_PER_SECOND = 6f
        const val GLOW_RADIANS_PER_SECOND = 4f
        const val TWO_PI = (2.0 * PI).toFloat()
    }
}

/** Pure column-major OpenGL camera maths for the maze's left-handed x=east, y=south, z=up space. */
internal object GhoulGlMatrices {
    fun buildViewProjection(
        out: FloatArray,
        projection: FloatArray,
        view: FloatArray,
        cameraX: Float,
        cameraY: Float,
        cameraZ: Float,
        yaw: Float,
        horizontalFovRadians: Float,
        aspect: Float,
        near: Float,
        far: Float,
    ) {
        require(out.size >= 16 && projection.size >= 16 && view.size >= 16)
        require(aspect > 0f && near > 0f && far > near)
        projection.fill(0f)
        val horizontalScale = 1f / tan(horizontalFovRadians / 2f)
        // Standard look-at makes north screen-right while facing east. Negating projection X
        // converts the maze's left-handed map coordinates so rider-right stays screen-right.
        projection[0] = -horizontalScale
        projection[5] = horizontalScale * aspect
        projection[10] = (far + near) / (near - far)
        projection[11] = -1f
        projection[14] = 2f * far * near / (near - far)

        val forwardX = cos(yaw)
        val forwardY = sin(yaw)
        val sideX = forwardY
        val sideY = -forwardX
        view.fill(0f)
        view[0] = sideX
        view[4] = sideY
        view[9] = 1f
        view[2] = -forwardX
        view[6] = -forwardY
        view[12] = -(sideX * cameraX + sideY * cameraY)
        view[13] = -cameraZ
        view[14] = forwardX * cameraX + forwardY * cameraY
        view[15] = 1f
        multiply(out, projection, view)
    }

    fun clipX(matrix: FloatArray, x: Float, y: Float, z: Float): Float =
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]

    fun billboardRightX(yaw: Float): Float = -sin(yaw)
    fun billboardRightY(yaw: Float): Float = cos(yaw)

    private fun multiply(out: FloatArray, left: FloatArray, right: FloatArray) {
        var column = 0
        while (column < 4) {
            var row = 0
            while (row < 4) {
                out[column * 4 + row] =
                    left[row] * right[column * 4] +
                    left[4 + row] * right[column * 4 + 1] +
                    left[8 + row] * right[column * 4 + 2] +
                    left[12 + row] * right[column * 4 + 3]
                row += 1
            }
            column += 1
        }
    }
}

/** Immutable rendering copy of the expanded maze grid, safe to hand to the GL thread. */
internal class GhoulGlMaze(
    val seed: Long,
    val rows: Int,
    val cols: Int,
    internal val floor: BooleanArray,
) {
    init {
        require(rows > 0 && cols > 0 && floor.size == rows * cols)
    }

    fun isFloor(row: Int, col: Int): Boolean =
        row in 0 until rows && col in 0 until cols && floor[row * cols + col]

    companion object {
        fun from(world: GhoulRunWorld): GhoulGlMaze {
            val rows = world.tileRows
            val cols = world.tileCols
            return GhoulGlMaze(
                world.seed,
                rows,
                cols,
                BooleanArray(rows * cols) { index -> world.isFloorTile(MazeTile(index / cols, index % cols)) },
            )
        }
    }
}

/** Interleaved xyz, normal xyz and uv geometry. It is generated once per maze then uploaded to a VBO. */
internal class GhoulMazeMesh(
    val vertices: FloatArray,
    val floorVertices: Int,
    val ceilingVertices: Int,
    val wallVertices: Int,
) {
    val vertexCount: Int get() = vertices.size / FLOATS_PER_VERTEX

    companion object {
        const val FLOATS_PER_VERTEX = 8
    }
}

/** Pure maze mesher. Only wall faces bordering walkable floor are emitted. */
internal object GhoulMazeMesher {
    fun build(maze: GhoulGlMaze): GhoulMazeMesh {
        var floorTiles = 0
        var wallFaces = 0
        for (row in 0 until maze.rows) for (col in 0 until maze.cols) if (maze.isFloor(row, col)) {
            floorTiles += 1
            if (!maze.isFloor(row - 1, col)) wallFaces += 1
            if (!maze.isFloor(row + 1, col)) wallFaces += 1
            if (!maze.isFloor(row, col - 1)) wallFaces += 1
            if (!maze.isFloor(row, col + 1)) wallFaces += 1
        }
        val floorVertices = floorTiles * 6
        val ceilingVertices = floorTiles * 6
        val wallVertices = wallFaces * 6
        val data = FloatArray((floorVertices + ceilingVertices + wallVertices) * GhoulMazeMesh.FLOATS_PER_VERTEX)
        var at = 0
        fun vertex(x: Float, y: Float, z: Float, nx: Float, ny: Float, nz: Float, u: Float, v: Float) {
            data[at++] = x; data[at++] = y; data[at++] = z
            data[at++] = nx; data[at++] = ny; data[at++] = nz
            data[at++] = u; data[at++] = v
        }
        fun quad(
            ax: Float, ay: Float, az: Float,
            bx: Float, by: Float, bz: Float,
            cx: Float, cy: Float, cz: Float,
            dx: Float, dy: Float, dz: Float,
            nx: Float, ny: Float, nz: Float,
        ) {
            vertex(ax, ay, az, nx, ny, nz, 0f, 0f); vertex(bx, by, bz, nx, ny, nz, 1f, 0f)
            vertex(cx, cy, cz, nx, ny, nz, 1f, 1f); vertex(ax, ay, az, nx, ny, nz, 0f, 0f)
            vertex(cx, cy, cz, nx, ny, nz, 1f, 1f); vertex(dx, dy, dz, nx, ny, nz, 0f, 1f)
        }
        // Keep material ranges contiguous so the renderer needs three draw calls for the maze.
        for (row in 0 until maze.rows) for (col in 0 until maze.cols) if (maze.isFloor(row, col)) {
            val x = col.toFloat(); val y = row.toFloat()
            quad(x, y, 0f, x + 1f, y, 0f, x + 1f, y + 1f, 0f, x, y + 1f, 0f, 0f, 0f, 1f)
        }
        for (row in 0 until maze.rows) for (col in 0 until maze.cols) if (maze.isFloor(row, col)) {
            val x = col.toFloat(); val y = row.toFloat()
            quad(x, y + 1f, 1f, x + 1f, y + 1f, 1f, x + 1f, y, 1f, x, y, 1f, 0f, 0f, -1f)
        }
        for (row in 0 until maze.rows) for (col in 0 until maze.cols) if (maze.isFloor(row, col)) {
            val x = col.toFloat(); val y = row.toFloat()
            if (!maze.isFloor(row - 1, col)) quad(x + 1f, y, 0f, x, y, 0f, x, y, 1f, x + 1f, y, 1f, 0f, 1f, 0f)
            if (!maze.isFloor(row + 1, col)) quad(x, y + 1f, 0f, x + 1f, y + 1f, 0f, x + 1f, y + 1f, 1f, x, y + 1f, 1f, 0f, -1f, 0f)
            if (!maze.isFloor(row, col - 1)) quad(x, y, 0f, x, y + 1f, 0f, x, y + 1f, 1f, x, y, 1f, 1f, 0f, 0f)
            if (!maze.isFloor(row, col + 1)) quad(x + 1f, y + 1f, 0f, x + 1f, y, 0f, x + 1f, y, 1f, x + 1f, y + 1f, 1f, -1f, 0f, 0f)
        }
        check(at == data.size)
        return GhoulMazeMesh(data, floorVertices, ceilingVertices, wallVertices)
    }
}

internal object GhoulGlLightColor {
    const val SHRINE_CYAN = 0
    const val EXIT_GREEN = 1
    const val GHOUL_RED = 2

    val rgb = floatArrayOf(0.18f, 0.95f, 1f, 0.2f, 1f, 0.35f, 1f, 0.08f, 0.03f)
    val radius = floatArrayOf(4.5f, 5f, 2.8f)
}

/** Allocation-free nearest-light selection into caller-owned arrays. */
internal object GhoulLightSelector {
    fun select(
        cameraX: Float,
        cameraY: Float,
        candidateX: FloatArray,
        candidateY: FloatArray,
        candidateKind: IntArray,
        candidateCount: Int,
        outXyr: FloatArray,
        outRgb: FloatArray,
        limit: Int,
    ): Int {
        val countLimit = limit.coerceAtMost(outXyr.size / 3).coerceAtMost(outRgb.size / 3)
        var selected = 0
        var index = 0
        while (index < candidateCount) {
            val dx = candidateX[index] - cameraX
            val dy = candidateY[index] - cameraY
            val distance2 = dx * dx + dy * dy
            var slot = selected.coerceAtMost(countLimit - 1)
            if (countLimit > 0) {
                if (selected == countLimit) {
                    val last = countLimit - 1
                    val lx = outXyr[last * 3] - cameraX
                    val ly = outXyr[last * 3 + 1] - cameraY
                    if (lx * lx + ly * ly <= distance2) {
                        index += 1
                        continue
                    }
                }
                while (slot > 0) {
                    val px = outXyr[(slot - 1) * 3] - cameraX
                    val py = outXyr[(slot - 1) * 3 + 1] - cameraY
                    if (px * px + py * py <= distance2) break
                    if (slot < countLimit) {
                        outXyr[slot * 3] = outXyr[(slot - 1) * 3]
                        outXyr[slot * 3 + 1] = outXyr[(slot - 1) * 3 + 1]
                        outXyr[slot * 3 + 2] = outXyr[(slot - 1) * 3 + 2]
                        outRgb[slot * 3] = outRgb[(slot - 1) * 3]
                        outRgb[slot * 3 + 1] = outRgb[(slot - 1) * 3 + 1]
                        outRgb[slot * 3 + 2] = outRgb[(slot - 1) * 3 + 2]
                    }
                    slot -= 1
                }
                if (slot < countLimit) {
                    val kind = candidateKind[index]
                    outXyr[slot * 3] = candidateX[index]
                    outXyr[slot * 3 + 1] = candidateY[index]
                    outXyr[slot * 3 + 2] = GhoulGlLightColor.radius[kind]
                    outRgb[slot * 3] = GhoulGlLightColor.rgb[kind * 3]
                    outRgb[slot * 3 + 1] = GhoulGlLightColor.rgb[kind * 3 + 1]
                    outRgb[slot * 3 + 2] = GhoulGlLightColor.rgb[kind * 3 + 2]
                    if (selected < countLimit) selected += 1
                }
            }
            index += 1
        }
        return selected
    }
}

/** Mutable, preallocated UI-to-GL frame packet. Arrays have fixed capacity and are never replaced. */
internal class GhoulGlSnapshot {
    var maze: GhoulGlMaze? = null
    var cameraX = 0f
    var cameraY = 0f
    var yaw = 0f
    var eye = 0.5f
    var lampRadius = 0f
    var lampPhase = 0f
    var glowPhase = 0f
    var diagnostics = false
    var ghoulPhaseA = 0f
    var ghoulPhaseB = 0f
    var ghoulFlare = 0f
    var ghoulBob = 0f
    var ghoulSway = 0f
    var ghoulDesaturation = 0f
    var lightCount = 0
    val lightXyr = FloatArray(MAX_LIGHTS * 3)
    val lightRgb = FloatArray(MAX_LIGHTS * 3)
    var spriteCount = 0
    val spriteXyk = FloatArray(MAX_SPRITES * 3)

    fun copyFrom(other: GhoulGlSnapshot) {
        maze = other.maze; cameraX = other.cameraX; cameraY = other.cameraY; yaw = other.yaw
        eye = other.eye; lampRadius = other.lampRadius; lampPhase = other.lampPhase; glowPhase = other.glowPhase
        diagnostics = other.diagnostics
        ghoulPhaseA = other.ghoulPhaseA; ghoulPhaseB = other.ghoulPhaseB; ghoulFlare = other.ghoulFlare
        ghoulBob = other.ghoulBob; ghoulSway = other.ghoulSway; ghoulDesaturation = other.ghoulDesaturation
        lightCount = other.lightCount; other.lightXyr.copyInto(lightXyr); other.lightRgb.copyInto(lightRgb)
        spriteCount = other.spriteCount; other.spriteXyk.copyInto(spriteXyk)
    }

    companion object {
        const val MAX_LIGHTS = 8
        const val MAX_SPRITES = 12
    }
}

/** Single-writer/single-reader double buffer; publication is one volatile index write. */
internal class GhoulGlSnapshotBuffer {
    private val frames = arrayOf(GhoulGlSnapshot(), GhoulGlSnapshot())
    @Volatile private var published = 0

    fun writable(): GhoulGlSnapshot = frames[1 - published]
    @Synchronized fun publish(frame: GhoulGlSnapshot) {
        require(frame === frames[0] || frame === frames[1])
        published = if (frame === frames[0]) 0 else 1
    }
    fun readable(): GhoulGlSnapshot = frames[published]
    @Synchronized fun readInto(target: GhoulGlSnapshot) {
        target.copyFrom(frames[published])
    }
}

internal enum class GhoulRendererType { Gl, Fallback }

/** Pure policy kept separate from Android callbacks so failure behaviour is deterministic and tested. */
internal class GhoulRendererSelection(glAvailable: Boolean = true) {
    var type: GhoulRendererType = if (glAvailable) GhoulRendererType.Gl else GhoulRendererType.Fallback
        private set
    var reason: String? = if (glAvailable) null else "OpenGL ES 2.0 unavailable"
        private set

    fun fail(message: String) {
        if (type == GhoulRendererType.Gl) {
            type = GhoulRendererType.Fallback
            reason = message
        }
    }
}
