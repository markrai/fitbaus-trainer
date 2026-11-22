// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

internal enum class GhoulIndustrialSurface { Floor, Ceiling, Wall }

internal object GhoulIndustrialArt {
    const val TILE_SIZE = 64
    const val ATLAS_SIZE = TILE_SIZE * 2
    const val VARIANT_COUNT = 4
    val FOG_COLOR: Int = rgb(22, 31, 39)

    fun variant(seed: Long, row: Int, col: Int, face: Int): Int {
        var value = seed.toInt() xor (seed ushr 32).toInt()
        value = value xor (row * 0x7FEB352D)
        value = value xor (col * 0x51ED270B)
        value = value xor (face * 0x1B873593)
        value = (value xor (value ushr 15)) * 0x2C1B3C6D
        return (value xor (value ushr 12)) and (VARIANT_COUNT - 1)
    }

    fun fog(distance: Float, height: Float): Float {
        val t = ((distance - 3f) / 11f).coerceIn(0f, 1f)
        val smooth = t * t * (3f - 2f * t)
        val low = 1f - (height / 0.85f).coerceIn(0f, 1f)
        return (smooth * (0.48f + 0.20f * low)).coerceIn(0f, 0.72f)
    }

    fun atlas(surface: GhoulIndustrialSurface): IntArray {
        val pixels = IntArray(ATLAS_SIZE * ATLAS_SIZE)
        for (y in 0 until ATLAS_SIZE) for (x in 0 until ATLAS_SIZE) {
            val variant = x / TILE_SIZE + (y / TILE_SIZE) * 2
            val px = x % TILE_SIZE
            val py = y % TILE_SIZE
            val grit = grit(px, py, variant + surface.ordinal * 4)
            pixels[y * ATLAS_SIZE + x] = when (surface) {
                GhoulIndustrialSurface.Wall -> wall(px, py, variant, grit)
                GhoulIndustrialSurface.Floor -> floor(px, py, variant, grit)
                GhoulIndustrialSurface.Ceiling -> ceiling(px, py, variant, grit)
            }
        }
        return pixels
    }

    private fun wall(x: Int, y: Int, variant: Int, grit: Int): Int {
        val plate = 86 + variant * 3 + grit
        if (x < 3 || x > 60 || y < 3 || y > 60) return rgb(29 + grit / 3, 37 + grit / 3, 43 + grit / 3)
        if (x == 3 || x == 60 || y == 3 || y == 60) return rgb(128 + grit, 142 + grit, 149 + grit)
        val rivet = (x - 9) * (x - 9) + (y - 9) * (y - 9) <= 12 ||
            (x - 54) * (x - 54) + (y - 9) * (y - 9) <= 12 ||
            (x - 9) * (x - 9) + (y - 54) * (y - 54) <= 12 ||
            (x - 54) * (x - 54) + (y - 54) * (y - 54) <= 12
        if (rivet) return if ((x + y) % 3 == 0) rgb(139, 153, 160) else rgb(34, 41, 46)
        if (variant == 1 && x in 13..50 && y in 19..43) {
            if (x in 14..49 && y % 6 < 3) return rgb(19 + grit / 3, 27 + grit / 3, 33 + grit / 3)
            return rgb(62 + grit, 74 + grit, 82 + grit)
        }
        if (variant == 2 && x in 17..45 && x % 14 < 4) return rgb(41 + grit, 52 + grit, 59 + grit)
        if (variant == 2 && x in 17..45 && x % 14 == 4) return rgb(136 + grit, 148 + grit, 155 + grit)
        if (variant == 3 && y in 45..52) {
            return if ((x + y) % 16 < 7) rgb(131 + grit, 118 + grit, 67 + grit) else rgb(43 + grit, 50 + grit, 55 + grit)
        }
        val scratch = (x * 11 + y * 7 + variant * 23) % 67 == 0
        if (scratch) return rgb(118 + grit, 129 + grit, 134 + grit)
        return rgb(plate, plate + 12, plate + 20)
    }

    private fun floor(x: Int, y: Int, variant: Int, grit: Int): Int {
        val seam = x < 2 || y < 2 || x > 61 || y > 61
        if (seam) return rgb(31 + grit / 2, 38 + grit / 2, 43 + grit / 2)
        val dust = if ((x * 3 + y * 13 + variant * 19) % 29 < 3) -14 else 0
        if (variant == 2 && x in 18..46 && y in 7..57) {
            if (x % 7 < 3) return rgb(22 + grit, 31 + grit, 37 + grit)
            return rgb(106 + grit, 117 + grit, 124 + grit)
        }
        if (variant == 3 && y in 48..55 && (x + y) % 18 < 8) {
            return rgb(105 + grit, 99 + grit, 64 + grit)
        }
        if (variant == 1 && (x % 22 < 2 || y % 22 < 2)) return rgb(53 + grit, 64 + grit, 71 + grit)
        return rgb(68 + grit + dust, 76 + grit + dust, 82 + grit + dust)
    }

    private fun ceiling(x: Int, y: Int, variant: Int, grit: Int): Int {
        if (x < 3 || y < 3 || x > 60 || y > 60) return rgb(17 + grit / 3, 24 + grit / 3, 30 + grit / 3)
        if (variant == 1 && x in 12..51 && y in 18..45) {
            if (x % 9 < 4) return rgb(22 + grit, 31 + grit, 36 + grit)
            return rgb(62 + grit, 71 + grit, 79 + grit)
        }
        if (variant == 2 && y % 16 < 4) return rgb(23 + grit, 29 + grit, 35 + grit)
        if (variant == 2 && y % 16 == 4) return rgb(97 + grit, 106 + grit, 113 + grit)
        if (variant == 3 && x in 26..38) return rgb(25 + grit, 35 + grit, 41 + grit)
        if (x == 5 || y == 5 || x == 58 || y == 58) return rgb(82 + grit, 91 + grit, 98 + grit)
        return rgb(43 + grit, 51 + grit, 59 + grit)
    }

    private fun grit(x: Int, y: Int, salt: Int): Int {
        var value = x * 0x45D9F3B xor y * 0x119DE1F3 xor salt * 0x27D4EB2D
        value = (value xor (value ushr 16)) * 0x45D9F3B
        return ((value ushr 24) and 15) - 7
    }

    private fun rgb(r: Int, g: Int, b: Int): Int =
        -0x1000000 or (r.coerceIn(0, 255) shl 16) or (g.coerceIn(0, 255) shl 8) or b.coerceIn(0, 255)
}
