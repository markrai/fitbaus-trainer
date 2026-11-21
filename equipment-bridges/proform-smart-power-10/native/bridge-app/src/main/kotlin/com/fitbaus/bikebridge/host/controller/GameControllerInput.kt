// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.controller

import android.content.SharedPreferences
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import com.fitbaus.arcade.BiketrisControllerInput
import com.fitbaus.arcade.HandPosition
import com.fitbaus.arcade.HandSource
import com.fitbaus.arcade.GhoulRunControllerInput
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

    fun belongsToController(device: InputDevice?): Boolean {
        if (device == null || device.isVirtual) return false
        if (supportsGames(device)) return true
        if (device.vendorId <= 0 || device.productId <= 0) return false
        return visible().any { candidate ->
            supportsGames(candidate) &&
                candidate.vendorId == device.vendorId &&
                candidate.productId == device.productId
        }
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

internal class ControllerPressEdge {
    private var held = false
    private var pending = false

    fun update(down: Boolean, repeatCount: Int) {
        if (down && !held && repeatCount == 0) pending = true
        held = down
    }

    fun take(): Boolean = pending.also { pending = false }

    fun reset() {
        held = false
        pending = false
    }
}

internal class ControllerReverseInput {
    private val press = ControllerPressEdge()
    private var keyDown = false
    private var hatDown = false

    fun onKey(down: Boolean, repeatCount: Int) {
        keyDown = down
        press.update(keyDown || hatDown, repeatCount)
    }

    fun sample(hatDown: Boolean): Boolean {
        this.hatDown = hatDown
        press.update(keyDown || hatDown, 0)
        return press.take()
    }

    fun reset() {
        keyDown = false
        hatDown = false
        press.reset()
    }
}

internal class GameControllerInput(private val prefs: SharedPreferences) {
    private var activeDeviceId = -1
    private var activeDeviceDescriptor: String? = null
    private var positionX = 0.5f
    private var axisX = 0f
    private var stickAxisX = 0f
    private var axisY = 0f
    private var hatX = 0f
    private var hatY = 0f
    private var leftDown = false
    private var rightDown = false
    private var downDown = false
    private var rotationPending = false
    private val leftInput = ControllerReverseInput()
    private val rightInput = ControllerReverseInput()
    private val reverseInput = ControllerReverseInput()
    private var previousNanos = -1L

    fun refresh() {
        val next = ControllerDevices.chosen(
            ControllerDevices.visible(),
            prefs.getString(ControllerDevices.SELECTED, null),
        )
        if ((next?.id ?: -1) != activeDeviceId) {
            activeDeviceId = next?.id ?: -1
            resetTransient()
        }
        activeDeviceDescriptor = next?.descriptor
    }

    fun resetTransient() {
        axisX = 0f
        stickAxisX = 0f
        axisY = 0f
        hatX = 0f
        hatY = 0f
        leftDown = false
        rightDown = false
        downDown = false
        rotationPending = false
        leftInput.reset()
        rightInput.reset()
        reverseInput.reset()
        previousNanos = -1L
    }

    fun hasController(): Boolean = activeDeviceId >= 0

    fun selectedDescriptor(): String? = activeDeviceDescriptor

    fun ownsDevice(deviceId: Int): Boolean = deviceId >= 0 && deviceId == activeDeviceId

    fun handleKey(event: KeyEvent, steerBricks: Boolean, mappedAction: String? = null): Boolean {
        if (!ownsDevice(event.deviceId)) return false
        if (steerBricks && (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_UP)) {
            val down = event.action == KeyEvent.ACTION_DOWN
            when (mappedAction) {
                "left" -> {
                    leftDown = down
                    leftInput.onKey(down, event.repeatCount)
                }
                "right" -> {
                    rightDown = down
                    rightInput.onKey(down, event.repeatCount)
                }
                "down" -> downDown = down
                "reverse" -> reverseInput.onKey(down, event.repeatCount)
                "rotate" -> if (down && event.repeatCount == 0) rotationPending = true
            }
        }
        return true
    }

    fun steeringHeld(): Boolean = leftDown || rightDown

    fun takeBiketrisInput(): BiketrisControllerInput {
        val rotate = rotationPending
        rotationPending = false
        val axis = ControllerSteering.axis(axisX)
        return BiketrisControllerInput(
            left = leftDown || axis < -0.45f,
            right = rightDown || axis > 0.45f,
            softDrop = downDown || ControllerSteering.axis(axisY) > 0.45f,
            rotate = rotate,
        )
    }

    fun takeGhoulRunInput(
        allowHatDown: Boolean = false,
        allowHatLeft: Boolean = false,
        allowHatRight: Boolean = false,
    ): GhoulRunControllerInput = GhoulRunControllerInput(
        leftPressed = leftInput.sample(allowHatLeft && hatX < -0.45f),
        rightPressed = rightInput.sample(allowHatRight && hatX > 0.45f),
        stickX = ControllerSteering.axis(stickAxisX),
        reversePressed = reverseInput.sample(allowHatDown && hatY > 0.45f),
    )

    fun handleMotion(event: MotionEvent): Boolean {
        if (!ownsDevice(event.deviceId)) return false
        if (!event.isFromSource(InputDevice.SOURCE_JOYSTICK)) return true
        val device = event.device ?: return true
        val stick = if (device.getMotionRange(MotionEvent.AXIS_X) != null) event.getAxisValue(MotionEvent.AXIS_X) else 0f
        val hat = if (device.getMotionRange(MotionEvent.AXIS_HAT_X) != null) event.getAxisValue(MotionEvent.AXIS_HAT_X) else 0f
        stickAxisX = stick
        hatX = hat
        axisX = if (abs(hat) > 0.1f) hat else stick
        val stickY = if (device.getMotionRange(MotionEvent.AXIS_Y) != null) event.getAxisValue(MotionEvent.AXIS_Y) else 0f
        hatY = if (device.getMotionRange(MotionEvent.AXIS_HAT_Y) != null) event.getAxisValue(MotionEvent.AXIS_HAT_Y) else 0f
        axisY = if (abs(hatY) > 0.1f) hatY else stickY
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
