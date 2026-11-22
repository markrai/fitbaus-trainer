// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

internal class GhoulSmokeArtTest {
    @Test
    fun emittersAreDeterministicAndRemainInsideWalkableCells() {
        val floor = BooleanArray(12 * 12) { index ->
            val row = index / 12
            val col = index % 12
            row in 1..10 && col in 1..10
        }
        val maze = GhoulGlMaze(4321L, 12, 12, floor)
        val emitters = GhoulSmokeArt.emitters(maze)
        assertTrue(emitters.isNotEmpty())
        assertEquals(0, emitters.size % 3)
        assertTrue(emitters.size <= floor.count { it } * 3)
        assertArrayEquals(emitters, GhoulSmokeArt.emitters(maze))
        assertFalse(emitters.contentEquals(GhoulSmokeArt.emitters(GhoulGlMaze(9876L, 12, 12, floor))))
        for (index in emitters.indices step 3) {
            val x = emitters[index]
            val y = emitters[index + 1]
            assertTrue(maze.isFloor(y.toInt(), x.toInt()))
            assertTrue(x - x.toInt() in 0.15f..0.85f)
            assertTrue(y - y.toInt() in 0.15f..0.85f)
        }
    }

    @Test
    fun visibilitySelectsOnlyNearestFrontFacingSourcesWithinRange() {
        val emitters = floatArrayOf(
            2f, 0f, 0f,
            4f, 0f, 0f,
            -2f, 0f, 0f,
            5f, 1f, 0f,
            3f, 0f, 0f,
            7f, 0f, 0f,
            1f, 3f, 0f,
        )
        val selected = IntArray(GhoulSmokeArt.MAX_VISIBLE_SOURCES)
        val distances = FloatArray(selected.size)
        val count = GhoulSmokeArt.selectVisible(emitters, 0f, 0f, 0f, selected, distances)
        assertEquals(4, count)
        assertArrayEquals(intArrayOf(0, 4, 1, 3), selected)
        assertArrayEquals(floatArrayOf(4f, 9f, 16f, 26f), distances)
    }

    @Test
    fun smokeTextureHasSoftTransparentBordersAndVisiblePlume() {
        val pixels = GhoulSmokeArt.texture()
        assertEquals(64 * 64, pixels.size)
        assertEquals(0, pixels[0] ushr 24)
        assertEquals(0, pixels[63] ushr 24)
        assertEquals(0, pixels[63 * 64] ushr 24)
        assertTrue(pixels.any { it ushr 24 > 140 })
        assertTrue(pixels.all { (it ushr 24) <= 191 })
        assertArrayEquals(pixels, GhoulSmokeArt.texture())
    }

    @Test
    fun smokeProgressAndFadeAreBoundedAndChangeWithTime() {
        for (plume in 0 until GhoulSmokeArt.PLUMES_PER_SOURCE) {
            val first = GhoulSmokeArt.progress(0f, 0.37f, plume)
            val later = GhoulSmokeArt.progress(1f, 0.37f, plume)
            assertTrue(first in 0f..1f)
            assertTrue(later in 0f..1f)
            assertFalse(first == later)
        }
        assertEquals(0f, GhoulSmokeArt.opacity(0f))
        assertTrue(GhoulSmokeArt.opacity(0.5f) > 0.7f)
        assertTrue(GhoulSmokeArt.opacity(1f) < 0.001f)
    }
}
