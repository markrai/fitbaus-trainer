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
            if (!permittedDevice(device.vendorId, device.productId, classes)) continue
            val before = result.size
            for (index in 0 until device.interfaceCount) {
                val iface = device.getInterface(index)
                for (endpointIndex in 0 until iface.endpointCount) {
                    val ep = iface.getEndpoint(endpointIndex)
                    if (ep.type != UsbConstants.USB_ENDPOINT_XFER_INT || ep.direction != UsbConstants.USB_DIR_IN) continue
                    if (ep.maxPacketSize !in 1..256) continue
                    result += HidCandidate(device.deviceName, device.vendorId, device.productId, index, iface.id, endpointIndex, ep.maxPacketSize)
                }
            }
            if (result.drop(before).map { it.interfaceIndex }.distinct().size != device.interfaceCount) {
                result.subList(before, result.size).clear()
            }
        }
        return result.sortedWith(compareBy({ it.vendorId }, { it.productId }, { it.deviceName }, { it.interfaceIndex }))
    }

    fun unique(candidates: List<HidCandidate>, selected: String?): HidCandidate? =
        if (selected.isNullOrBlank()) null else candidates.filter { it.key == selected }.singleOrNull()
}

internal data class HidReport(
    val bytes: ByteArray,
    val sequence: Long,
    val interfaceIndex: Int = 0,
    val endpointIndex: Int = 0,
) {
    fun hex(): String = bytes.take(64).joinToString(" ") { "%02X".format(it.toInt() and 255) }
}

internal data class HidBinding(
    val index: Int,
    val mask: Int,
    val pressed: Int,
    val interfaceIndex: Int = -1,
    val endpointIndex: Int = -1,
) {
    fun matches(report: ByteArray): Boolean = index in report.indices && (report[index].toInt() and mask) == pressed

    fun matches(report: HidReport): Boolean =
        (interfaceIndex < 0 || (interfaceIndex == report.interfaceIndex && endpointIndex == report.endpointIndex)) &&
            matches(report.bytes)

    fun encode(): String = if (interfaceIndex < 0) "$index:$mask:$pressed"
        else "$index:$mask:$pressed:$interfaceIndex:$endpointIndex"

    companion object {
        fun decode(encoded: String?): HidBinding? {
            val parts = encoded?.split(":") ?: return null
            if (parts.size != 3 && parts.size != 5) return null
            val i = parts[0].toIntOrNull() ?: return null
            val m = parts[1].toIntOrNull() ?: return null
            val p = parts[2].toIntOrNull() ?: return null
            val iface = if (parts.size == 5) parts[3].toIntOrNull() ?: return null else -1
            val endpoint = if (parts.size == 5) parts[4].toIntOrNull() ?: return null else -1
            return if (i in 0..255 && m in 1..255 && p in 0..255 && p and m == p &&
                (iface == -1 && endpoint == -1 || iface in 0..255 && endpoint in 0..255)
            ) HidBinding(i, m, p, iface, endpoint) else null
        }

        fun learn(neutral: HidReport, pressed: HidReport): HidBinding? {
            if (neutral.interfaceIndex != pressed.interfaceIndex || neutral.endpointIndex != pressed.endpointIndex) return null
            return learn(neutral.bytes, pressed.bytes)?.copy(
                interfaceIndex = neutral.interfaceIndex,
                endpointIndex = neutral.endpointIndex,
            )
        }

        fun learn(neutral: ByteArray, pressed: ByteArray): HidBinding? {
            if (neutral.size != pressed.size || neutral.isEmpty()) return null
            val changed = neutral.indices.filter { neutral[it] != pressed[it] }
            if (changed.size != 1) return null
            val index = changed[0]
            val old = neutral[index].toInt() and 255
            val next = pressed[index].toInt() and 255
            val hat = (old and 15) in 8..15 && (next and 15) in 0..7
            val mask = if (hat) 15 else old xor next
            return if (mask == 0) null else HidBinding(index, mask, next and mask)
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
    private val reportByEndpoint = HashMap<Pair<Int, Int>, HidReport>()
    private val counter = AtomicLong(0L)
    private var connection: UsbDeviceConnection? = null
    private var claimedInterfaces: List<UsbInterface> = emptyList()
    private var readers: List<HidReader> = emptyList()
    private var active: HidCandidate? = null
    private var generation = 0L
    @Volatile private var stateText = "Released"
    @Volatile private var androidLeak = false
    private var positionX = 0.5f
    private var lastTick = -1L

    fun candidates(): List<HidCandidate> = ExclusiveHidPolicy.candidates(manager.deviceList.values)

    fun disabledByUser(): Boolean =
        prefs.getString(ControllerDevices.SELECTED, null) == ControllerDevices.DISABLED

    fun selected(): HidCandidate? {
        activeCandidate()?.let { return it }
        val chosen = ControllerDevices.chosen(
            ControllerDevices.visible(),
            prefs.getString(ControllerDevices.SELECTED, null),
        ) ?: return null
        val matches = candidates().filter { it.vendorId == chosen.vendorId && it.productId == chosen.productId }
        if (matches.map { it.deviceName }.distinct().size != 1) return null
        return matches.firstOrNull()
    }

    fun isPermitted(candidate: HidCandidate): Boolean {
        val device = manager.deviceList[candidate.deviceName] ?: return false
        return manager.hasPermission(device)
    }

    fun status(): String = stateText
    fun latest(): HidReport? = report.get()
    fun isActive(): Boolean = synchronized(lock) { connection != null && active != null }
    fun activeCandidate(): HidCandidate? = synchronized(lock) { active }

    fun startFromPreference(): Boolean = start()

    private data class HidReader(
        val request: UsbRequest,
        val buffer: ByteBuffer,
        val candidate: HidCandidate,
    )

    fun start(): Boolean = synchronized(lock) {
        if (connection != null && active != null) return true
        val candidate = selected()
        if (candidate == null) {
            stateText = "No unambiguous USB HID gamepad detected"
            return false
        }
        val device = manager.deviceList[candidate.deviceName]
        if (device == null || !manager.hasPermission(device)) {
            stateText = "USB permission needed or controller disconnected"
            return false
        }
        val sources = candidates().filter { it.deviceName == candidate.deviceName }
        if (sources.isEmpty() || sources.map { it.interfaceIndex }.distinct().size != device.interfaceCount) {
            stateText = "Unsafe or incomplete HID interface layout"
            return false
        }
        val handle = manager.openDevice(device)
        if (handle == null) {
            stateText = "Could not open USB controller"
            return false
        }
        val interfaces = ArrayList<UsbInterface>()
        val opened = ArrayList<HidReader>()
        var failed = false
        try {
            for (i in 0 until device.interfaceCount) {
                val usbInterface = device.getInterface(i)
                if (!handle.claimInterface(usbInterface, true)) {
                    failed = true
                    break
                }
                interfaces.add(usbInterface)
            }
            if (!failed) {
                for (source in sources) {
                    val usbInterface = device.getInterface(source.interfaceIndex)
                    val endpoint = usbInterface.getEndpoint(source.endpointIndex)
                    val reader = UsbRequest()
                    if (!reader.initialize(handle, endpoint)) {
                        reader.close()
                        failed = true
                        break
                    }
                    opened.add(HidReader(reader, ByteBuffer.allocateDirect(source.maxPacket), source))
                }
            }
        } catch (_: Exception) {
            failed = true
        }
        if (failed || opened.isEmpty()) {
            opened.forEach { try { it.request.close() } catch (_: Exception) {} }
            interfaces.asReversed().forEach { try { handle.releaseInterface(it) } catch (_: Exception) {} }
            handle.close()
            stateText = "Failed to claim every USB HID interface"
            return false
        }
        connection = handle
        claimedInterfaces = interfaces
        readers = opened
        active = candidate
        generation++
        val token = generation
        report.set(null)
        reportByEndpoint.clear()
        androidLeak = false
        stateText = "Claimed ${interfaces.size} HID interfaces; awaiting reports"
        Thread({ readLoop(handle, opened, token) }, "FitbausHid").apply { isDaemon = true; start() }
        return true
    }

    @Suppress("DEPRECATION")
    private fun readLoop(handle: UsbDeviceConnection, opened: List<HidReader>, token: Long) {
        try {
            for (reader in opened) {
                reader.buffer.clear()
                if (!reader.request.queue(reader.buffer, reader.candidate.maxPacket)) return
            }
            while (synchronized(lock) { token == generation && connection === handle }) {
                val completed = handle.requestWait() ?: break
                val reader = opened.firstOrNull { it.request === completed } ?: break
                val count = reader.buffer.position().coerceIn(0, reader.candidate.maxPacket)
                if (count > 0) {
                    reader.buffer.flip()
                    val bytes = ByteArray(count)
                    reader.buffer.get(bytes)
                    synchronized(lock) {
                        if (token == generation && connection === handle) {
                            val nextReport = HidReport(bytes, counter.incrementAndGet(), reader.candidate.interfaceIndex, reader.candidate.endpointIndex)
                            report.set(nextReport)
                            reportByEndpoint[nextReport.interfaceIndex to nextReport.endpointIndex] = nextReport
                            if (!androidLeak) stateText = "Reading USB HID reports from ${claimedInterfaces.size} claimed interfaces"
                        }
                    }
                }
                if (!synchronized(lock) { token == generation && connection === handle }) break
                reader.buffer.clear()
                if (!reader.request.queue(reader.buffer, reader.candidate.maxPacket)) break
            }
        } catch (_: Exception) {
            if (synchronized(lock) { token == generation }) stateText = "USB HID read failed"
        } finally {
            synchronized(lock) {
                if (token == generation && connection === handle) stopLocked("USB HID reader stopped; reconnect to retry")
            }
        }
    }

    fun stop() = synchronized(lock) { stopLocked() }

    private fun stopLocked(reason: String = "Released") {
        generation++
        val oldReaders = readers
        val oldConnection = connection
        val oldInterfaces = claimedInterfaces
        readers = emptyList()
        connection = null
        claimedInterfaces = emptyList()
        active = null
        report.set(null)
        reportByEndpoint.clear()
        lastTick = -1L
        stateText = reason
        androidLeak = false
        oldReaders.forEach { try { it.request.cancel() } catch (_: Exception) {} }
        oldReaders.forEach { try { it.request.close() } catch (_: Exception) {} }
        if (oldConnection != null) {
            oldInterfaces.asReversed().forEach {
                try { oldConnection.releaseInterface(it) } catch (_: Exception) {}
            }
            try { oldConnection.close() } catch (_: Exception) {}
        }
    }

    fun belongsTo(device: android.view.InputDevice?): Boolean {
        val chosen = activeCandidate() ?: return false
        return device != null && device.vendorId == chosen.vendorId && device.productId == chosen.productId
    }

    fun noteAndroidEvent() {
        if (isActive()) {
            androidLeak = true
            stateText = "WARNING: Android still delivers controller keys after USB claim"
        }
    }

    fun isBindingPressed(binding: HidBinding?): Boolean = boundInputPressed(binding)

    private fun boundInputPressed(binding: HidBinding?): Boolean {
        if (binding == null) return false
        val reading = synchronized(lock) {
            if (binding.interfaceIndex < 0) report.get()
            else reportByEndpoint[binding.interfaceIndex to binding.endpointIndex]
        }
        return reading?.let(binding::matches) ?: false
    }

    fun sampleBricks(nowNanos: Long): HandPosition? {
        if (!isActive()) return null
        if (report.get() == null) return null
        val leftBinding = HidBinding.decode(prefs.getString(ExclusiveHidPolicy.PREF_LEFT, null))
        val rightBinding = HidBinding.decode(prefs.getString(ExclusiveHidPolicy.PREF_RIGHT, null))
        if (leftBinding == null && rightBinding == null) return null
        val left = boundInputPressed(leftBinding)
        val right = boundInputPressed(rightBinding)
        val delta = if (lastTick < 0L) 0L else nowNanos - lastTick
        lastTick = nowNanos
        positionX = ControllerSteering.advance(positionX, 0f, left, right, delta)
        return HandPosition(positionX, 0.5f, 1f, nowNanos, HandSource.Touch)
    }
}
