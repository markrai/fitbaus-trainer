// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

internal class GhoulMapOverlayLayoutTest {
    @Test
    fun splitViewRemainsTheOriginalHalfAndHalfLayout() {
        val rect = GhoulMapOverlayLayout.bounds(1000f, 700f, 54f, 10f, GhoulMapViewMode.Split)
        assertEquals(500f, rect.left)
        assertEquals(54f, rect.top)
        assertEquals(1000f, rect.right)
        assertEquals(700f, rect.bottom)
        assertEquals(501f, GhoulMapOverlayLayout.bounds(1001f, 700f, 54f, 10f, GhoulMapViewMode.Split).left)
    }

    @Test
    fun overlayStartsInUpperRightAtReadableMinimumSize() {
        val rect = GhoulMapOverlayLayout.bounds(1000f, 700f, 54f, 10f, GhoulMapViewMode.Overlay)
        assertEquals(990f, rect.right)
        assertEquals(64f, rect.top)
        assertEquals(380f, rect.width)
        assertEquals(646f * GhoulMapOverlayLayout.DEFAULT_HEIGHT_SHARE, rect.height, 0.001f)
        assertTrue(rect.left > 0f)
        assertTrue(rect.bottom < 700f)
    }

    @Test
    fun resizeKeepsUpperRightAnchorAndClampsToSafeLimits() {
        val a = GhoulMapOverlayLayout.bounds(1000f, 700f, 54f, 10f, GhoulMapViewMode.Overlay)
        val shares = GhoulMapOverlayLayout.resizedShares(
            GhoulMapOverlayLayout.DEFAULT_WIDTH_SHARE, GhoulMapOverlayLayout.DEFAULT_HEIGHT_SHARE,
            a.width, a.height, -700f, 500f, 1000f, 646f,
        )
        assertEquals(GhoulMapOverlayLayout.MAX_WIDTH_SHARE, shares.first)
        assertEquals(GhoulMapOverlayLayout.MAX_HEIGHT_SHARE, shares.second)
        val large = GhoulMapOverlayLayout.bounds(1000f, 700f, 54f, 10f, GhoulMapViewMode.Overlay, shares.first, shares.second)
        assertEquals(a.right, large.right)
        assertEquals(a.top, large.top)
        assertTrue(large.width > a.width)
        assertTrue(large.height > a.height)
        assertTrue(large.bottom < 700f)

        val tiny = GhoulMapOverlayLayout.resizedShares(
            shares.first, shares.second, large.width, large.height, 900f, -900f, 1000f, 646f,
        )
        assertEquals(GhoulMapOverlayLayout.MIN_WIDTH_SHARE, tiny.first)
        assertEquals(GhoulMapOverlayLayout.MIN_HEIGHT_SHARE, tiny.second)
    }

    @Test
    fun opacityAlwaysStaysInReadablePresetRange() {
        assertEquals(20, GhoulMapOverlayLayout.opacity(-100))
        assertEquals(40, GhoulMapOverlayLayout.opacity(40))
        assertEquals(70, GhoulMapOverlayLayout.opacity(79))
        assertEquals(80, GhoulMapOverlayLayout.opacity(100))
    }

    @Test
    fun smallScreensCannotOverflowThePlayableArea() {
        val rect = GhoulMapOverlayLayout.bounds(
            320f, 180f, 54f, 40f, GhoulMapViewMode.Overlay, 1f, 1f,
        )
        assertTrue(rect.left >= 0f)
        assertTrue(rect.top >= 54f)
        assertTrue(rect.right <= 320f)
        assertTrue(rect.bottom <= 180f)
    }
}
