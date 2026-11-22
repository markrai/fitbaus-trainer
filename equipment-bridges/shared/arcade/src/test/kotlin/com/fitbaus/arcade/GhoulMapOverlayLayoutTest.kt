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
            a.width, a.height, -700f, 500f, 1000f, 646f, 24f,
        )
        assertEquals(GhoulMapOverlayLayout.MAX_WIDTH_SHARE, shares.first)
        assertEquals(GhoulMapOverlayLayout.MAX_HEIGHT_SHARE, shares.second)
        val large = GhoulMapOverlayLayout.bounds(1000f, 700f, 54f, 10f, GhoulMapViewMode.Overlay, shares.first, shares.second)
        assertEquals(0f, large.left, 0.001f)
        assertEquals(54f, large.top, 0.001f)
        assertEquals(1000f, large.right, 0.001f)
        assertEquals(700f, large.bottom, 0.001f)
        assertTrue(large.width > a.width)
        assertTrue(large.height > a.height)

        val tiny = GhoulMapOverlayLayout.resizedShares(
            shares.first, shares.second, large.width, large.height, 900f, -900f, 1000f, 646f, 24f,
        )
        assertEquals(GhoulMapOverlayLayout.MIN_WIDTH_SHARE, tiny.first)
        assertEquals(GhoulMapOverlayLayout.MIN_HEIGHT_SHARE, tiny.second)
    }

    @Test
    fun dragNearTheViewportEdgeSnapsToFullCoverage() {
        val start = GhoulMapOverlayLayout.bounds(1000f, 700f, 54f, 10f, GhoulMapViewMode.Overlay)
        val widthAlmostFull = 1000f - 12f
        val heightAlmostFull = 646f - 12f
        val shares = GhoulMapOverlayLayout.resizedShares(
            GhoulMapOverlayLayout.DEFAULT_WIDTH_SHARE, GhoulMapOverlayLayout.DEFAULT_HEIGHT_SHARE,
            start.width, start.height,
            start.width - widthAlmostFull, heightAlmostFull - start.height,
            1000f, 646f, 24f,
        )
        assertEquals(1f, shares.first)
        assertEquals(1f, shares.second)
        val bounds = GhoulMapOverlayLayout.bounds(
            1000f, 700f, 54f, 10f, GhoulMapViewMode.Overlay, shares.first, shares.second,
        )
        assertEquals(0f, bounds.left, 0.001f)
        assertEquals(54f, bounds.top, 0.001f)
        assertEquals(1000f, bounds.right, 0.001f)
        assertEquals(700f, bounds.bottom, 0.001f)
    }

    @Test
    fun dragOutsideSnapRangeRemainsGradual() {
        val resized = GhoulMapOverlayLayout.resizedShares(
            GhoulMapOverlayLayout.DEFAULT_WIDTH_SHARE, GhoulMapOverlayLayout.DEFAULT_HEIGHT_SHARE,
            380f, 374.68f, -570f, 221.32f,
            1000f, 646f, 24f,
        )
        assertEquals(0.95f, resized.first, 0.0001f)
        assertEquals(0.9226f, resized.second, 0.0001f)
    }

    @Test
    fun heightCanFillTheViewportBehindTheRpmGaugeWithoutForcingFullWidth() {
        val rect = GhoulMapOverlayLayout.bounds(
            1000f, 700f, 54f, 10f, GhoulMapViewMode.Overlay,
            GhoulMapOverlayLayout.DEFAULT_WIDTH_SHARE, GhoulMapOverlayLayout.MAX_HEIGHT_SHARE,
        )
        assertEquals(54f, rect.top, 0.001f)
        assertEquals(700f, rect.bottom, 0.001f)
        assertEquals(380f, rect.width, 0.001f)
        assertEquals(990f, rect.right, 0.001f)
    }

    @Test
    fun widthCanFillViewportIndependentlyOfOverlayHeight() {
        val rect = GhoulMapOverlayLayout.bounds(
            1000f, 700f, 54f, 10f, GhoulMapViewMode.Overlay,
            GhoulMapOverlayLayout.MAX_WIDTH_SHARE, GhoulMapOverlayLayout.DEFAULT_HEIGHT_SHARE,
        )
        assertEquals(0f, rect.left, 0.001f)
        assertEquals(1000f, rect.right, 0.001f)
        assertEquals(64f, rect.top, 0.001f)
        assertTrue(rect.bottom < 700f)
    }

    @Test
    fun resizeClampsBeyondFullScreenAndPreservesExistingMinimum() {
        val min = GhoulMapOverlayLayout.bounds(
            1000f, 700f, 54f, 10f, GhoulMapViewMode.Overlay, -4f, -4f,
        )
        assertEquals(360f, min.width, 0.001f)
        assertEquals(646f * GhoulMapOverlayLayout.MIN_HEIGHT_SHARE, min.height, 0.001f)
        val oversized = GhoulMapOverlayLayout.bounds(
            1000f, 700f, 54f, 10f, GhoulMapViewMode.Overlay, 3f, 3f,
        )
        assertEquals(0f, oversized.left, 0.001f)
        assertEquals(54f, oversized.top, 0.001f)
        assertEquals(1000f, oversized.right, 0.001f)
        assertEquals(700f, oversized.bottom, 0.001f)
    }

    @Test
    fun opacityAlwaysStaysInReadablePresetRange() {
        assertEquals(20, GhoulMapOverlayLayout.opacity(-100))
        assertEquals(40, GhoulMapOverlayLayout.opacity(40))
        assertEquals(70, GhoulMapOverlayLayout.opacity(79))
        assertEquals(80, GhoulMapOverlayLayout.opacity(100))
        assertEquals(20, GhoulMapOverlayLayout.opacityAtFraction(-1f))
        assertEquals(20, GhoulMapOverlayLayout.opacityAtFraction(0f))
        assertEquals(40, GhoulMapOverlayLayout.opacityAtFraction(1f / 3f))
        assertEquals(80, GhoulMapOverlayLayout.opacityAtFraction(1f))
        assertEquals(80, GhoulMapOverlayLayout.opacityAtFraction(2f))
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
