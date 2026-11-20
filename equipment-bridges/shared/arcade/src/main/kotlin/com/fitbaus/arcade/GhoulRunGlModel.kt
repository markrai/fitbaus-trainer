// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.tan

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
    var timeSeconds = 0f
    var diagnostics = false
    var lightCount = 0
    val lightXyr = FloatArray(MAX_LIGHTS * 3)
    val lightRgb = FloatArray(MAX_LIGHTS * 3)
    var spriteCount = 0
    val spriteXyk = FloatArray(MAX_SPRITES * 3)

    fun copyFrom(other: GhoulGlSnapshot) {
        maze = other.maze; cameraX = other.cameraX; cameraY = other.cameraY; yaw = other.yaw
        eye = other.eye; lampRadius = other.lampRadius; lampPhase = other.lampPhase; glowPhase = other.glowPhase
        timeSeconds = other.timeSeconds; diagnostics = other.diagnostics
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
