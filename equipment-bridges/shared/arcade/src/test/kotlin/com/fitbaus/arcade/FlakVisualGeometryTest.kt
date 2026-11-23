// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FlakVisualGeometryTest {
    @Test
    fun higherResolutionFramebufferRetainsOriginalWorldCoordinates() {
        val config = FlakConfig()
        assertEquals(config.width.toInt(), FlakVisualGeometry.WIDTH)
        assertEquals(config.height.toInt(), FlakVisualGeometry.HEIGHT)
        assertEquals(2, FlakVisualGeometry.RENDER_SCALE)
        assertEquals(512, FlakVisualGeometry.BITMAP_WIDTH)
        assertEquals(288, FlakVisualGeometry.BITMAP_HEIGHT)
        assertTrue(FlakVisualGeometry.SPRITE_SCALE >= FlakVisualGeometry.RENDER_SCALE)
        assertEquals(FlakVisualGeometry.BITMAP_WIDTH * FlakVisualGeometry.BITMAP_HEIGHT * 4, 589_824)
    }

    @Test
    fun scrollingTerrainWrapsAtBothEdgesWithoutOutOfBoundsIndexing() {
        for (size in listOf(7, 256, 512)) {
            for (shift in listOf(-1234, -size, -1, 0, 1, size, 1234)) {
                for (x in listOf(0, 1, size / 2, size - 1)) {
                    val actual = FlakVisualGeometry.index(x, shift, size)
                    assertTrue(actual in 0 until size)
                    assertEquals((x.toLong() + shift.toLong()).mod(size.toLong()).toInt(), actual)
                }
            }
        }
    }

    @Test
    fun explosionFadeNeverReboundsOrExceedsAlphaBounds() {
        var prior = 255
        for (step in 0..100) {
            val progress = step / 100f
            val alpha = FlakVisualGeometry.opacity(progress)
            assertTrue(alpha in 0..255)
            assertTrue(alpha <= prior)
            prior = alpha
        }
        assertEquals(255, FlakVisualGeometry.opacity(-1f))
        assertEquals(0, FlakVisualGeometry.opacity(1f))
        assertEquals(0, FlakVisualGeometry.opacity(2f))
    }

    @Test
    fun explosionLifetimeClampsToVisibleInterval() {
        assertEquals(0f, FlakVisualGeometry.progress(-1f, 0.5f))
        assertEquals(0.5f, FlakVisualGeometry.progress(0.25f, 0.5f))
        assertEquals(1f, FlakVisualGeometry.progress(1f, 0.5f))
        assertEquals(1f, FlakVisualGeometry.progress(1f, 0f))
    }
}
