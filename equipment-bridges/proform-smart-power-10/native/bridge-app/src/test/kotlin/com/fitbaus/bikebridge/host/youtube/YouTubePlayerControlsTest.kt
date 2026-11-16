// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class YouTubePlayerControlsTest {
    @Test
    fun verticalVolumeIsLoudAtTheTopAndSilentAtTheBottom() {
        assertEquals(15, VerticalSliderMath.valueAt(y = 20f, top = 20f, bottom = 320f, max = 15))
        assertEquals(0, VerticalSliderMath.valueAt(y = 320f, top = 20f, bottom = 320f, max = 15))
        assertEquals(8, VerticalSliderMath.valueAt(y = 170f, top = 20f, bottom = 320f, max = 15))
        assertEquals(15, VerticalSliderMath.valueAt(y = -50f, top = 20f, bottom = 320f, max = 15), "dragging past the top stays at maximum")
        assertEquals(0, VerticalSliderMath.valueAt(y = 900f, top = 20f, bottom = 320f, max = 15), "dragging past the bottom stays at zero")
        assertEquals(0, VerticalSliderMath.valueAt(y = 100f, top = 20f, bottom = 20f, max = 15), "collapsed track")
    }

    @Test
    fun thumbPositionMatchesTheValue() {
        assertEquals(20f, VerticalSliderMath.yFor(15, 20f, 320f, 15))
        assertEquals(320f, VerticalSliderMath.yFor(0, 20f, 320f, 15))
        assertEquals(170f, VerticalSliderMath.yFor(15, 20f, 320f, 30))
        assertEquals(20f, VerticalSliderMath.yFor(99, 20f, 320f, 15), "values above max are clamped")
        for (value in 0..15) {
            assertEquals(value, VerticalSliderMath.valueAt(VerticalSliderMath.yFor(value, 20f, 320f, 15), 20f, 320f, 15))
        }
    }

    @Test
    fun volumeSitsInAColumnRightOfTheVideoAndTheBottomSliderIsBrightness() {
        val content = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/YouTubeContent.kt").readText()
        val player = content.substring(content.indexOf("private fun buildPlayer()"), content.indexOf("private fun render("))
        assertTrue(player.indexOf("stage.addView(area") < player.indexOf("stage.addView(buildVolumeColumn()"), "volume column is to the right of the video")
        assertTrue(player.contains("label(\"BRIGHTNESS\""))
        assertTrue(player.contains("brightness.set(progress + MIN_BRIGHTNESS)"))
        assertFalse(player.contains("brightnessBar.setOnSeekBarChangeListener") && player.substringAfter("brightnessBar.setOnSeekBarChangeListener").substringBefore("controls.addView(brightnessBar").contains("setStreamVolume"))
        assertTrue(player.contains("audio.setStreamVolume(AudioManager.STREAM_MUSIC, level, 0)"))
        assertEquals(5, YouTubeContent.MIN_BRIGHTNESS, "the slider cannot black out the console screen")
        assertEquals(100, YouTubeContent.MAX_BRIGHTNESS)
    }

    @Test
    fun brightnessUsesTheBridgeBrightnessStoreThroughTheActivity() {
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val control = activity.substring(activity.indexOf("private val youtubeBrightness"), activity.indexOf("private val refresh"))
        assertTrue(control.contains("BridgeProcess.brightness(this@NativeBridgeActivity).record(percent)"))
        assertTrue(control.contains("applyStoredBrightness()"))
        assertTrue(activity.contains("YouTubeContent(this, getSharedPreferences(YouTubeContent.PREFS, Context.MODE_PRIVATE), youtubeBrightness)"))
        for (forbidden in listOf("Usb", "Resistance", "NativeBridgeService", "startService")) assertFalse(control.contains(forbidden), forbidden)
    }
}
