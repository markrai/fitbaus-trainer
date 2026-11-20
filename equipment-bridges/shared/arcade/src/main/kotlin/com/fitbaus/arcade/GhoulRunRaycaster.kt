// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.tan

/**
 * Solid/floor lookup for the expanded (2N+1) x (2N+1) GHOUL RUN tile grid, flattened for the
 * raycaster's inner loop. Continuous coordinates put tile (row, col) at x in [col, col + 1) and
 * y in [row, row + 1), so x follows columns (east) and y follows rows (south). Anything outside
 * the grid is solid.
 */
internal class GhoulRayGrid(val rows: Int, val cols: Int, internal val solid: BooleanArray) {
    init {
        require(rows > 0 && cols > 0 && solid.size == rows * cols)
    }

    fun isSolid(row: Int, col: Int): Boolean =
        row < 0 || col < 0 || row >= rows || col >= cols || solid[row * cols + col]

    companion object {
        fun from(world: GhoulRunWorld): GhoulRayGrid {
            val rows = world.tileRows
            val cols = world.tileCols
            val solid = BooleanArray(rows * cols) { index -> !world.isFloorTile(MazeTile(index / cols, index % cols)) }
            return GhoulRayGrid(rows, cols, solid)
        }
    }
}

/** Per-column ray results, reused every frame. */
internal class GhoulRayHits(val columns: Int) {
    /** Perpendicular (fish-eye corrected) distance to the wall, in tiles. */
    val distance = FloatArray(columns)

    /** [GhoulRaycaster.SIDE_X] for faces on a vertical grid line (east/west), [GhoulRaycaster.SIDE_Y] otherwise. */
    val side = IntArray(columns)
    val tileRow = IntArray(columns)
    val tileCol = IntArray(columns)

    /** Horizontal position across the hit wall face, 0..1. */
    val wallU = FloatArray(columns)
}

/** Pure DDA raycasting on [GhoulRayGrid]. No Android types, so the maths is unit-testable. */
internal object GhoulRaycaster {
    const val SIDE_X = 0
    const val SIDE_Y = 1

    /** Continuous tile-space centre of a maze cell. */
    fun cellX(col: Float): Float = 2f * col + 1.5f
    fun cellY(row: Float): Float = 2f * row + 1.5f

    /** Yaw (radians, 0 = east, +pi/2 = south) of a maze heading. */
    fun yawOf(direction: MazeDirection): Float = atan2(direction.dr.toFloat(), direction.dc.toFloat())

    /** Casts [hits].columns rays across a [fovRadians] view centred on [yaw] from (x, y). */
    fun castView(grid: GhoulRayGrid, x: Float, y: Float, yaw: Float, fovRadians: Float, hits: GhoulRayHits) {
        val dirX = cos(yaw)
        val dirY = sin(yaw)
        val planeScale = tan(fovRadians / 2f)
        val planeX = -dirY * planeScale
        val planeY = dirX * planeScale
        val columns = hits.columns
        val scale = 2f / columns
        // Even columns (and the last) are cast; an odd column between two hits on the same face of the
        // same tile is interpolated, which is exact for the distance. Halves the DDA work on the
        // console's interpreted runtime.
        var column = 0
        while (column < columns) {
            val cameraX = (column + 0.5f) * scale - 1f
            castRay(grid, x, y, dirX + planeX * cameraX, dirY + planeY * cameraX, hits, column)
            column += 2
        }
        if (columns % 2 == 0) {
            val last = columns - 1
            val cameraX = (last + 0.5f) * scale - 1f
            castRay(grid, x, y, dirX + planeX * cameraX, dirY + planeY * cameraX, hits, last)
        }
        val side = hits.side
        val rowHit = hits.tileRow
        val colHit = hits.tileCol
        val distance = hits.distance
        val wallU = hits.wallU
        column = 1
        while (column + 1 < columns) {
            val a = column - 1
            val b = column + 1
            val cameraA = (a + 0.5f) * scale - 1f
            val cameraB = (b + 0.5f) * scale - 1f
            val sameFace = side[a] == side[b] && rowHit[a] == rowHit[b] && colHit[a] == colHit[b] &&
                (dirX + planeX * cameraA > 0f) == (dirX + planeX * cameraB > 0f) &&
                (dirY + planeY * cameraA > 0f) == (dirY + planeY * cameraB > 0f)
            if (sameFace) {
                // 1/distance (wall height) is linear in camera x across a plane: harmonic mean is exact.
                distance[column] = 2f / (1f / distance[a] + 1f / distance[b])
                side[column] = side[a]
                rowHit[column] = rowHit[a]
                colHit[column] = colHit[a]
                wallU[column] = (wallU[a] + wallU[b]) * 0.5f
            } else {
                val cameraX = (column + 0.5f) * scale - 1f
                castRay(grid, x, y, dirX + planeX * cameraX, dirY + planeY * cameraX, hits, column)
            }
            column += 2
        }
    }

    /**
     * One DDA ray. Writes the perpendicular distance along the camera direction implied by the
     * un-normalised ray (camera dir + plane offset), which is what keeps walls straight.
     */
    fun castRay(grid: GhoulRayGrid, x: Float, y: Float, rayX: Float, rayY: Float, hits: GhoulRayHits, column: Int) {
        var mapX = floor(x).toInt()
        var mapY = floor(y).toInt()
        val deltaX = if (rayX == 0f) Float.MAX_VALUE else abs(1f / rayX)
        val deltaY = if (rayY == 0f) Float.MAX_VALUE else abs(1f / rayY)
        val stepX: Int
        val stepY: Int
        var sideX: Float
        var sideY: Float
        if (rayX < 0f) {
            stepX = -1
            sideX = (x - mapX) * deltaX
        } else {
            stepX = 1
            sideX = (mapX + 1f - x) * deltaX
        }
        if (rayY < 0f) {
            stepY = -1
            sideY = (y - mapY) * deltaY
        } else {
            stepY = 1
            sideY = (mapY + 1f - y) * deltaY
        }
        var side = SIDE_X
        val rows = grid.rows
        val cols = grid.cols
        val solid = grid.solid
        var guard = rows + cols + 4
        while (guard-- > 0) {
            if (sideX < sideY) {
                sideX += deltaX
                mapX += stepX
                side = SIDE_X
            } else {
                sideY += deltaY
                mapY += stepY
                side = SIDE_Y
            }
            // Inlined isSolid: calls are costly on the console's interpreted runtime.
            if (mapX < 0 || mapY < 0 || mapX >= cols || mapY >= rows || solid[mapY * cols + mapX]) break
        }
        val perpendicular = if (side == SIDE_X) sideX - deltaX else sideY - deltaY
        val distance = perpendicular.coerceAtLeast(MIN_DISTANCE)
        val along = if (side == SIDE_X) y + distance * rayY else x + distance * rayX
        hits.distance[column] = distance
        hits.side[column] = side
        hits.tileRow[column] = mapY
        hits.tileCol[column] = mapX
        hits.wallU[column] = along - floor(along)
    }

    private const val MIN_DISTANCE = 0.02f
}
