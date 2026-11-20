// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.controller

import android.content.SharedPreferences
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import com.fitbaus.arcade.HandPosition
import com.fitbaus.arcade.HandSource
import kotlin.math.abs

internal object ControllerDevices {
    const val PREFS = "game_controllers"
    const val SELECTED = "selected_descriptor"
    const val DISABLED = "disabled"

    fun hasSource(sources: Int, source: Int): Boolean = sources and source == source

    fun supportsGames(device: InputDevice): Boolean = !device.isVirtual && (
        hasSource(device.sources, InputDevice.SOURCE_DPAD) ||
            hasSource(device.sources, InputDevice.SOURCE_GAMEPAD) ||
            hasSource(device.sources, InputDevice.SOURCE_JOYSTICK)
        )

    fun visible(): List<InputDevice> = InputDevice.getDeviceIds().toList()
        .mapNotNull { InputDevice.getDevice(it) }
        .filter { supportsGames(it) || hasSource(it.sources, InputDevice.SOURCE_MOUSE) }
        .sortedWith(compareByDescending<InputDevice> { supportsGames(it) }.thenBy { it.name })

    fun chosen(devices: List<InputDevice>, descriptor: String?): InputDevice? {
        if (descriptor == DISABLED) return null
        val candidates = devices.filter(::supportsGames)
        return if (descriptor == null) candidates.singleOrNull()
        else candidates.firstOrNull { it.descriptor == descriptor }
    }

    fun category(device: InputDevice): String = when {
        hasSource(device.sources, InputDevice.SOURCE_JOYSTICK) -> "Joystick"
        hasSource(device.sources, InputDevice.SOURCE_GAMEPAD) -> "Gamepad"
        hasSource(device.sources, InputDevice.SOURCE_DPAD) -> "D-pad"
        else -> "Pointer only"
    }
}

internal object ControllerSteering {
    private const val DEADZONE = 0.18f
    private const val UNITS_PER_SECOND = 0.95f

    fun axis(value: Float): Float {
        if (!value.isFinite()) return 0f
        val clamped = value.coerceIn(-1f, 1f)
        return when {
            abs(clamped) <= DEADZONE -> 0f
            clamped > 0f -> (clamped - DEADZONE) / (1f - DEADZONE)
            else -> (clamped + DEADZONE) / (1f - DEADZONE)
        }
    }

    fun advance(position: Float, analog: Float, left: Boolean, right: Boolean, elapsedNanos: Long): Float {
        val direction = when {
            left && !right -> -1f
            right && !left -> 1f
            else -> axis(analog)
        }
        val deltaSeconds = elapsedNanos.coerceIn(0L, 100_000_000L) / 1_000_000_000f
        return (position + direction * deltaSeconds * UNITS_PER_SECOND).coerceIn(0f, 1f)
    }
}

internal object ControllerGameplayKeys {
    fun consumes(keyCode: Int): Boolean = keyCode >= KeyEvent.KEYCODE_UNKNOWN
}

internal class GameControllerInput(private val prefs: SharedPreferences) {
    private var activeDeviceId = -1
    private var positionX = 0.5f
    private var axisX = 0f
    private var leftDown = false
    private var rightDown = false
    private var previousNanos = -1L

    fun refresh() {
        val next = ControllerDevices.chosen(
            ControllerDevices.visible(),
            prefs.getString(ControllerDevices.SELECTED, null),
        )?.id ?: -1
        if (next != activeDeviceId) {
            activeDeviceId = next
            resetTransient()
        }
    }

    fun resetTransient() {
        axisX = 0f
        leftDown = false
        rightDown = false
        previousNanos = -1L
    }

    fun ownsDevice(deviceId: Int): Boolean = deviceId >= 0 && deviceId == activeDeviceId

    fun handleKey(event: KeyEvent, steerBricks: Boolean): Boolean {
        if (!ownsDevice(event.deviceId)) return false
        if (steerBricks && (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_UP)) {
            val down = event.action == KeyEvent.ACTION_DOWN
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> leftDown = down
                KeyEvent.KEYCODE_DPAD_RIGHT -> rightDown = down
            }
        }
        return true
    }

    fun handleMotion(event: MotionEvent): Boolean {
        if (!ownsDevice(event.deviceId)) return false
        if (!event.isFromSource(InputDevice.SOURCE_JOYSTICK)) return true
        val device = event.device ?: return true
        val stick = if (device.getMotionRange(MotionEvent.AXIS_X) != null) event.getAxisValue(MotionEvent.AXIS_X) else 0f
        val hat = if (device.getMotionRange(MotionEvent.AXIS_HAT_X) != null) event.getAxisValue(MotionEvent.AXIS_HAT_X) else 0f
        axisX = if (abs(hat) > 0.1f) hat else stick
        return true
    }

    fun sample(nowNanos: Long): HandPosition? {
        if (activeDeviceId < 0) return null
        val elapsed = if (previousNanos < 0L) 0L else nowNanos - previousNanos
        previousNanos = nowNanos
        positionX = ControllerSteering.advance(positionX, axisX, leftDown, rightDown, elapsed)
        return HandPosition(positionX, 0.5f, 1f, nowNanos, HandSource.Touch)
    }
}
