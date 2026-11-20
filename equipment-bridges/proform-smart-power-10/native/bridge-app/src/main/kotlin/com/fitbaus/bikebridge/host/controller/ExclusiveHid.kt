// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.controller

import android.content.Context
import android.content.SharedPreferences
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import com.fitbaus.arcade.HandPosition
import com.fitbaus.arcade.HandSource
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal data class HidCandidate(
    val deviceName: String,
    val vendorId: Int,
    val productId: Int,
    val interfaceIndex: Int,
    val interfaceNumber: Int,
    val endpointIndex: Int,
    val maxPacket: Int,
) {
    val key: String get() = "$vendorId:$productId:$interfaceIndex:$interfaceNumber"
    val label: String get() = "%04X:%04X  HID IF %d  /  %s".format(vendorId, productId, interfaceNumber, deviceName)
}

internal object ExclusiveHidPolicy {
    const val PREF_ENABLED = "exclusive_hid_enabled"
    const val PREF_KEY = "exclusive_hid_key"
    const val PREF_LEFT = "exclusive_hid_left"
    const val PREF_RIGHT = "exclusive_hid_right"

    fun permittedDevice(vendor: Int, product: Int, classes: List<Int>): Boolean {
        if (vendor == 0x213C || (vendor == 0x10C4 && product == 0xEA60)) return false
        if (classes.isEmpty() || classes.any { it != UsbConstants.USB_CLASS_HID }) return false
        return true
    }

    fun candidates(devices: Collection<UsbDevice>): List<HidCandidate> {
        val result = ArrayList<HidCandidate>()
        for (device in devices) {
            val classes = (0 until device.interfaceCount).map { device.getInterface(it).interfaceClass }
            if (!permittedDevice(device.vendorId, device.productId, classes) || device.interfaceCount != 1) continue
            for (index in 0 until device.interfaceCount) {
                val iface = device.getInterface(index)
                if (iface.interfaceSubclass == 1 && (iface.interfaceProtocol == 1 || iface.interfaceProtocol == 2)) continue
                for (endpointIndex in 0 until iface.endpointCount) {
                    val ep = iface.getEndpoint(endpointIndex)
                    if (ep.type != UsbConstants.USB_ENDPOINT_XFER_INT || ep.direction != UsbConstants.USB_DIR_IN) continue
                    if (ep.maxPacketSize !in 1..256) continue
                    result += HidCandidate(device.deviceName, device.vendorId, device.productId, index, iface.id, endpointIndex, ep.maxPacketSize)
                }
            }
        }
        return result.sortedWith(compareBy({ it.vendorId }, { it.productId }, { it.deviceName }, { it.interfaceIndex }))
    }

    fun unique(candidates: List<HidCandidate>, selected: String?): HidCandidate? =
        if (selected.isNullOrBlank()) null else candidates.filter { it.key == selected }.singleOrNull()
}

internal data class HidReport(val bytes: ByteArray, val sequence: Long) {
    fun hex(): String = bytes.take(64).joinToString(" ") { "%02X".format(it.toInt() and 255) }
}

internal data class HidBinding(val index: Int, val mask: Int, val pressed: Int) {
    fun matches(report: ByteArray): Boolean = index in report.indices && (report[index].toInt() and mask) == pressed
    fun encode(): String = "$index:$mask:$pressed"

    companion object {
        fun decode(encoded: String?): HidBinding? {
            val parts = encoded?.split(":") ?: return null
            if (parts.size != 3) return null
            val i = parts[0].toIntOrNull() ?: return null
            val m = parts[1].toIntOrNull() ?: return null
            val p = parts[2].toIntOrNull() ?: return null
            return if (i in 0..255 && m in 1..255 && p in 0..255 && p and m == p) HidBinding(i, m, p) else null
        }

        fun learn(neutral: ByteArray, pressed: ByteArray): HidBinding? {
            if (neutral.size != pressed.size || neutral.isEmpty()) return null
            val changed = neutral.indices.filter { neutral[it] != pressed[it] }
            if (changed.size != 1) return null
            val index = changed[0]
            val mask = (neutral[index].toInt() xor pressed[index].toInt()) and 255
            return if (mask == 0) null else HidBinding(index, mask, pressed[index].toInt() and mask)
        }
    }
}

internal class ExclusiveHid(
    context: Context,
    private val prefs: SharedPreferences = context.getSharedPreferences(ControllerDevices.PREFS, Context.MODE_PRIVATE),
    private val manager: UsbManager = context.applicationContext.getSystemService(Context.USB_SERVICE) as UsbManager,
) {
    private val lock = Any()
    private val report = AtomicReference<HidReport?>(null)
    private val counter = AtomicLong(0L)
    private var connection: UsbDeviceConnection? = null
    private var iface: UsbInterface? = null
    private var request: UsbRequest? = null
    private var active: HidCandidate? = null
    private var generation = 0L
    @Volatile private var stateText = "Released"
    private var positionX = 0.5f
    private var lastTick = -1L

    fun candidates(): List<HidCandidate> = ExclusiveHidPolicy.candidates(manager.deviceList.values)
    fun selected(): HidCandidate? = ExclusiveHidPolicy.unique(candidates(), prefs.getString(ExclusiveHidPolicy.PREF_KEY, null))

    fun isPermitted(candidate: HidCandidate): Boolean {
        val device = manager.deviceList[candidate.deviceName] ?: return false
        return manager.hasPermission(device)
    }

    fun status(): String = stateText
    fun latest(): HidReport? = report.get()
    fun isActive(): Boolean = synchronized(lock) { connection != null && active != null }
    fun activeCandidate(): HidCandidate? = synchronized(lock) { active }

    fun startFromPreference(): Boolean {
        if (!prefs.getBoolean(ExclusiveHidPolicy.PREF_ENABLED, false)) return false
        return start()
    }

    fun start(): Boolean = synchronized(lock) {
        stopLocked()
        val candidate = selected()
        if (candidate == null) {
            stateText = "No unique selected HID interface"
            return false
        }
        val device = manager.deviceList[candidate.deviceName]
        if (device == null || !manager.hasPermission(device)) {
            stateText = "USB permission needed or controller disconnected"
            return false
        }
        if (ExclusiveHidPolicy.unique(candidates(), candidate.key) != candidate) {
            stateText = "USB interface changed; refusing claim"
            return false
        }
        val usbInterface = device.getInterface(candidate.interfaceIndex)
        val endpoint = usbInterface.getEndpoint(candidate.endpointIndex)
        val handle = manager.openDevice(device)
        if (handle == null) {
            stateText = "Could not open USB device"
            return false
        }
        if (!handle.claimInterface(usbInterface, true)) {
            handle.close()
            stateText = "Exclusive kernel HID claim failed"
            return false
        }
        val reader = UsbRequest()
        if (!reader.initialize(handle, endpoint)) {
            handle.releaseInterface(usbInterface)
            handle.close()
            stateText = "Cannot read HID interrupt endpoint"
            return false
        }
        connection = handle
        iface = usbInterface
        request = reader
        active = candidate
        generation += 1L
        val token = generation
        report.set(null)
        stateText = "HID interface claimed; awaiting raw input (system ownership unverified)"
        Thread({ readLoop(handle, reader, candidate.maxPacket, token) }, "FitbausHid-" + candidate.interfaceNumber)
            .apply { isDaemon = true; start() }
        return true
    }

    private fun readLoop(handle: UsbDeviceConnection, reader: UsbRequest, packetSize: Int, token: Long) {
        val buffer = ByteBuffer.allocateDirect(packetSize)
        try {
            while (synchronized(lock) { token == generation && connection === handle }) {
                buffer.clear()
                if (!reader.queue(buffer, packetSize)) break
                if (handle.requestWait() !== reader) break
                val count = buffer.position().coerceIn(0, packetSize)
                if (count > 0) {
                    buffer.flip()
                    val bytes = ByteArray(count)
                    buffer.get(bytes)
                    report.set(HidReport(bytes, counter.incrementAndGet()))
                    stateText = "Receiving raw USB HID reports (system exclusivity requires on-bike check)"
                }
            }
        } catch (_: Exception) {
            if (synchronized(lock) { token == generation }) stateText = "USB HID read failed"
        } finally {
            synchronized(lock) {
                if (token == generation && connection === handle) stopLocked()
            }
        }
    }

    fun stop() = synchronized(lock) { stopLocked() }

    private fun stopLocked() {
        generation += 1L
        val oldRequest = request
        val oldConnection = connection
        val oldInterface = iface
        request = null
        connection = null
        iface = null
        active = null
        report.set(null)
        lastTick = -1L
        stateText = "Released"
        try { oldRequest?.cancel() } catch (_: Exception) {}
        try { oldRequest?.close() } catch (_: Exception) {}
        if (oldConnection != null) {
            try { if (oldInterface != null) oldConnection.releaseInterface(oldInterface) } catch (_: Exception) {}
            try { oldConnection.close() } catch (_: Exception) {}
        }
    }

    fun belongsTo(device: android.view.InputDevice?): Boolean {
        val chosen = activeCandidate() ?: return false
        return device != null && device.vendorId == chosen.vendorId && device.productId == chosen.productId
    }

    fun noteAndroidEvent() {
        if (isActive()) stateText = "WARNING: Android still delivers keys; exclusive ownership is unverified"
    }

    fun sampleBricks(nowNanos: Long): HandPosition? {
        if (!isActive()) return null
        val reading = report.get() ?: return null
        val leftBinding = HidBinding.decode(prefs.getString(ExclusiveHidPolicy.PREF_LEFT, null))
        val rightBinding = HidBinding.decode(prefs.getString(ExclusiveHidPolicy.PREF_RIGHT, null))
        if (leftBinding == null && rightBinding == null) return null
        val left = leftBinding?.matches(reading.bytes) ?: false
        val right = rightBinding?.matches(reading.bytes) ?: false
        val delta = if (lastTick < 0L) 0L else nowNanos - lastTick
        lastTick = nowNanos
        positionX = ControllerSteering.advance(positionX, 0f, left, right, delta)
        return HandPosition(positionX, 0.5f, 1f, nowNanos, HandSource.Touch)
    }
}
