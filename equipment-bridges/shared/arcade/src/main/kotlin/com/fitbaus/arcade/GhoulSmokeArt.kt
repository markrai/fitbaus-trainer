// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

internal object GhoulSmokeArt {
    const val TEXTURE_SIZE = 64
    const val MAX_VISIBLE_SOURCES = 4
    const val PLUMES_PER_SOURCE = 2
    private const val RANGE_SQUARED = 36f

    fun emitters(maze: GhoulGlMaze): FloatArray {
        val candidates = FloatArray(maze.rows * maze.cols * 3)
        var count = 0
        for (row in 0 until maze.rows) for (col in 0 until maze.cols) {
            if (!maze.isFloor(row, col)) continue
            val north = !maze.isFloor(row - 1, col) && GhoulIndustrialArt.variant(maze.seed, row, col, 2) == 1
            val south = !maze.isFloor(row + 1, col) && GhoulIndustrialArt.variant(maze.seed, row, col, 3) == 1
            val west = !maze.isFloor(row, col - 1) && GhoulIndustrialArt.variant(maze.seed, row, col, 4) == 1
            val east = !maze.isFloor(row, col + 1) && GhoulIndustrialArt.variant(maze.seed, row, col, 5) == 1
            val grate = GhoulIndustrialArt.variant(maze.seed, row, col, 0) == 2
            val ambient = GhoulIndustrialArt.variant(maze.seed, row, col, 6) == 0
            if (!north && !south && !west && !east && !grate && !ambient) continue
            candidates[count++] = col + when {
                west -> 0.18f
                east -> 0.82f
                else -> 0.5f
            }
            candidates[count++] = row + when {
                north -> 0.18f
                south -> 0.82f
                else -> 0.5f
            }
            candidates[count++] = GhoulIndustrialArt.variant(maze.seed, row, col, 7) * 0.23f +
                GhoulIndustrialArt.variant(maze.seed, row, col, 8) * 0.04f
        }
        return candidates.copyOf(count)
    }

    fun selectVisible(
        emitters: FloatArray,
        cameraX: Float,
        cameraY: Float,
        yaw: Float,
        selected: IntArray,
        distances: FloatArray,
    ): Int {
        require(selected.size == distances.size)
        val forwardX = cos(yaw)
        val forwardY = sin(yaw)
        var count = 0
        for (index in 0 until emitters.size / 3) {
            val offset = index * 3
            val dx = emitters[offset] - cameraX
            val dy = emitters[offset + 1] - cameraY
            val d2 = dx * dx + dy * dy
            if (d2 < 0.64f || d2 > RANGE_SQUARED) continue
            val ahead = dx * forwardX + dy * forwardY
            if (ahead < 0.25f || ahead * ahead < d2 * 0.55f) continue
            var at = 0
            while (at < count && distances[at] < d2) at++
            if (at >= selected.size) continue
            if (count < selected.size) count++
            var shift = count - 1
            while (shift > at) {
                selected[shift] = selected[shift - 1]
                distances[shift] = distances[shift - 1]
                shift--
            }
            selected[at] = index
            distances[at] = d2
        }
        return count
    }

    fun progress(seconds: Float, phase: Float, plume: Int): Float {
        val cycles = seconds * (if (plume == 0) 0.31f else 0.25f) + phase + plume * 0.53f
        return cycles - kotlin.math.floor(cycles)
    }

    fun opacity(progress: Float): Float = max(0f, sin(progress * PI.toFloat())) * 0.78f

    fun texture(): IntArray {
        val pixels = IntArray(TEXTURE_SIZE * TEXTURE_SIZE)
        for (y in 0 until TEXTURE_SIZE) for (x in 0 until TEXTURE_SIZE) {
            val u = (x + 0.5f) / TEXTURE_SIZE
            val v = (y + 0.5f) / TEXTURE_SIZE
            val density = max(
                max(puff(u, v, 0.46f, 0.66f, 0.35f, 0.30f), puff(u, v, 0.61f, 0.48f, 0.32f, 0.29f)),
                max(puff(u, v, 0.39f, 0.37f, 0.31f, 0.25f), puff(u, v, 0.53f, 0.23f, 0.28f, 0.20f)),
            )
            val texture = 0.88f + 0.12f * sin(u * 23f + v * 17f) * sin(u * 11f - v * 19f)
            val alpha = (density * texture * 191f).toInt().coerceIn(0, 191)
            pixels[y * TEXTURE_SIZE + x] = (alpha shl 24) or (172 shl 16) or (185 shl 8) or 192
        }
        return pixels
    }

    private fun puff(u: Float, v: Float, cx: Float, cy: Float, rx: Float, ry: Float): Float {
        val x = (u - cx) / rx
        val y = (v - cy) / ry
        val edge = (1f - x * x - y * y).coerceIn(0f, 1f)
        return edge * edge * (3f - 2f * edge)
    }
}
