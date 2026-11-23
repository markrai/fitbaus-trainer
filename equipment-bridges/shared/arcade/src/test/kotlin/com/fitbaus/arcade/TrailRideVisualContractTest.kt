// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import java.io.File
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TrailRideVisualContractTest {
    private val view = File("src/main/kotlin/com/fitbaus/arcade/TrailRideView.kt").readText()
    private val art = File("src/main/kotlin/com/fitbaus/arcade/TrailRideArtwork.kt").readText()

    @Test
    fun framebufferDoublesVisualResolutionWithoutChangingWorldCoordinates() {
        assertEquals(2, TrailRideArtwork.PRESENTATION_SCALE)
        assertEquals(4, TrailRideArtwork.SOURCE_SCALE)
        assertEquals(512, TrailRideArtwork.PRESENTATION_WIDTH)
        assertEquals(288, TrailRideArtwork.PRESENTATION_HEIGHT)
        assertEquals(256 * TrailRideArtwork.PRESENTATION_SCALE, TrailRideArtwork.PRESENTATION_WIDTH)
        assertEquals(144 * TrailRideArtwork.PRESENTATION_SCALE, TrailRideArtwork.PRESENTATION_HEIGHT)
        assertTrue(view.contains("private val projection = TrailProjection(width = LOGICAL_W.toFloat(), horizonY = HORIZON.toFloat())"))
        assertTrue(view.contains("private val terrain = Bitmap.createBitmap(LOGICAL_W, LOGICAL_H, Bitmap.Config.ARGB_8888)"))
        assertTrue(view.contains("terrain.setPixels(pixels, 0, LOGICAL_W, 0, 0, LOGICAL_W, LOGICAL_H)"))
        assertTrue(view.contains("fbCanvas.scale(TrailRideArtwork.PRESENTATION_SCALE.toFloat()"))
        assertFalse(view.contains("isFilterBitmap = false"))
    }

    @Test
    fun allOriginalSceneryKindsHaveCachedNearAndHazedFarArt() {
        for (kind in TrailRideArtwork.Kind.entries) {
            assertTrue(art.contains("Kind.${kind.name} ->"), kind.name)
            assertTrue(view.contains("TrailRideArtwork.Kind.${kind.name}"), kind.name)
        }
        assertTrue(view.contains("TrailRideArtwork.create(kind, w, h)"))
        assertTrue(view.contains("TrailRideArtwork.hazed(art, FAR_HAZE)"))
        assertTrue(view.contains("drawItems(camX, yaw)"))
        assertTrue(view.contains("itemShadow.set("))
        assertTrue(view.contains("cockpit.draw(fbCanvas, game.speed / game.config.maxSpeed)"))
    }

    @Test
    fun visualChangesDoNotIntroduceSimulationOrEquipmentInputs() {
        val forbidden = listOf(
            "requestResistance", "setResistance", "requestIncline", "setIncline",
            "usbManager", "BluetoothGatt", "android.hardware.usb",
        )
        for (token in forbidden) {
            assertFalse(art.contains(token), token)
        }
        assertTrue(view.contains("drawGround(d, camX, yaw)"))
        assertTrue(view.contains("collectItems(d)"))
        assertTrue(view.contains("drawHandlebars(ridingVisual)"))
    }
}
