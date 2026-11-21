// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

internal class GhoulMapCameraTest {
    @Test
    fun everyCardinalHeadingProjectsTravelToTheSameUpperRightDirection() {
        val camera = GhoulMapCamera()
        for (heading in MazeDirection.entries) {
            camera.follow(GhoulRaycaster.yawOf(heading))
            assertEquals(20f, camera.x(heading.dr.toFloat(), heading.dc.toFloat(), 40f), 0.0001f)
            assertEquals(-10f, camera.y(heading.dr.toFloat(), heading.dc.toFloat(), 20f), 0.0001f)
            assertTrue(camera.quarter != null)
        }
    }

    @Test
    fun intermediateYawRotatesWorldContinuouslyWithoutTiltingTheCamera() {
        val camera = GhoulMapCamera()
        for (index in -16..16) {
            val yaw = index * (PI / 16).toFloat()
            camera.follow(yaw)
            assertEquals(20f, camera.x(sin(yaw), cos(yaw), 40f), 0.0002f)
            assertEquals(-10f, camera.y(sin(yaw), cos(yaw), 20f), 0.0002f)
            if (index % 8 != 0) assertNull(camera.quarter)
        }
    }

    @Test
    fun orbitKeepsRiderAtTheOriginAndPreservesFourDistinctWorldBearings() {
        val camera = GhoulMapCamera()
        for (heading in MazeDirection.entries) {
            camera.follow(GhoulRaycaster.yawOf(heading))
            assertEquals(0f, camera.x(0f, 0f, 50f))
            assertEquals(0f, camera.y(0f, 0f, 25f))
            val northX = camera.x(-1f, 0f, 50f)
            val northY = camera.y(-1f, 0f, 25f)
            assertTrue(northX.isFinite() && northY.isFinite())
            assertTrue(northX * northX + northY * northY > 1f)
            assertEquals(-northX, camera.x(1f, 0f, 50f), 0.0001f)
            assertEquals(-northY, camera.y(1f, 0f, 25f), 0.0001f)
        }
    }

    @Test
    fun headingWrapAroundIsEquivalentToTheSameCardinalView() {
        val camera = GhoulMapCamera()
        camera.follow(0f)
        val eastX = camera.x(2f, -3f, 40f)
        val eastY = camera.y(2f, -3f, 20f)
        assertEquals(0, camera.quarter)
        camera.follow((2 * PI).toFloat())
        assertEquals(0, camera.quarter)
        assertEquals(eastX, camera.x(2f, -3f, 40f), 0.0001f)
        assertEquals(eastY, camera.y(2f, -3f, 20f), 0.0001f)
    }
}
