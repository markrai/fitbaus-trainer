// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.controller

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GameControllerInputTest {
    @Test
    fun deadzoneRejectsDriftAndPreservesFullStickTravel() {
        assertEquals(0f, ControllerSteering.axis(0f))
        assertEquals(0f, ControllerSteering.axis(0.12f))
        assertEquals(0f, ControllerSteering.axis(-0.18f))
        assertEquals(0f, ControllerSteering.axis(Float.NaN))
        assertEquals(1f, ControllerSteering.axis(1f))
        assertEquals(-1f, ControllerSteering.axis(-1f))
        assertEquals(1f, ControllerSteering.axis(20f))
        assertTrue(ControllerSteering.axis(0.7f) in 0.6f..0.7f)
    }

    @Test
    fun directionalKeysSteerAndClampInsideThePlayfield() {
        assertEquals(0.405f, ControllerSteering.advance(0.5f, 0f, true, false, 100_000_000L), 0.0001f)
        assertEquals(0.595f, ControllerSteering.advance(0.5f, 0f, false, true, 100_000_000L), 0.0001f)
        assertEquals(0.5f, ControllerSteering.advance(0.5f, 0f, false, false, 100_000_000L), 0.0001f)
        assertEquals(0.5f, ControllerSteering.advance(0.5f, 0f, true, true, 100_000_000L), 0.0001f)
        assertEquals(0f, ControllerSteering.advance(0.01f, 0f, true, false, 100_000_000L))
        assertEquals(1f, ControllerSteering.advance(0.99f, 0f, false, true, 100_000_000L))
    }

    @Test
    fun elapsedFrameTimeIsCappedAgainstSuspensionJumps() {
        val ordinary = ControllerSteering.advance(0.5f, 1f, false, false, 100_000_000L)
        val paused = ControllerSteering.advance(0.5f, 1f, false, false, 12_000_000_000L)
        assertEquals(ordinary, paused)
        assertEquals(0.5f, ControllerSteering.advance(0.5f, 1f, false, false, 0L))
    }

    @Test
    fun controllerGameplayConsumesDeliveredNavigationAndFaceButtons() {
        val intercepted = listOf(
            android.view.KeyEvent.KEYCODE_BACK,
            android.view.KeyEvent.KEYCODE_ESCAPE,
            android.view.KeyEvent.KEYCODE_MENU,
            android.view.KeyEvent.KEYCODE_APP_SWITCH,
            android.view.KeyEvent.KEYCODE_DPAD_LEFT,
            android.view.KeyEvent.KEYCODE_DPAD_RIGHT,
            android.view.KeyEvent.KEYCODE_DPAD_UP,
            android.view.KeyEvent.KEYCODE_DPAD_DOWN,
            android.view.KeyEvent.KEYCODE_DPAD_CENTER,
            android.view.KeyEvent.KEYCODE_BUTTON_A,
            android.view.KeyEvent.KEYCODE_BUTTON_B,
            android.view.KeyEvent.KEYCODE_BUTTON_X,
            android.view.KeyEvent.KEYCODE_BUTTON_Y,
            android.view.KeyEvent.KEYCODE_BUTTON_START,
            android.view.KeyEvent.KEYCODE_BUTTON_SELECT,
            android.view.KeyEvent.KEYCODE_BUTTON_MODE,
            android.view.KeyEvent.KEYCODE_BUTTON_1,
            android.view.KeyEvent.KEYCODE_BUTTON_16,
        )
        for (key in intercepted) assertTrue(ControllerGameplayKeys.consumes(key), "gameplay key: $key")
    }

    @Test
    fun systemKeysAndUnrecognizedInputAreNotClaimed() {
        val excluded = listOf(
            android.view.KeyEvent.KEYCODE_HOME,
            android.view.KeyEvent.KEYCODE_VOLUME_UP,
            android.view.KeyEvent.KEYCODE_VOLUME_DOWN,
            android.view.KeyEvent.KEYCODE_POWER,
            android.view.KeyEvent.KEYCODE_UNKNOWN,
            android.view.KeyEvent.KEYCODE_A,
        )
        for (key in excluded) assertFalse(ControllerGameplayKeys.consumes(key), "reserved key: $key")
    }

    @Test
    fun sourceBitmaskRecognizesCombinedDpadAndGamepadSources() {
        assertTrue(ControllerDevices.hasSource(0x00000201, 0x00000201))
        assertTrue(ControllerDevices.hasSource(0x00000401 or 0x00000201, 0x00000201))
        assertFalse(ControllerDevices.hasSource(0x00002002, 0x00000201))
    }
}
