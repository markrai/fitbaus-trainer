// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import com.fitbaus.bikebridge.host.usb.BikeUsbConstants
import com.fitbaus.bikebridge.protocol.BridgeMetricJson
import com.fitbaus.bikebridge.protocol.NativeTelemetrySnapshot
import java.net.Inet4Address
import java.net.NetworkInterface

internal data class BridgeUiState(
    val phase: UsbPhase,
    val statusText: String,
    val usbText: String,
    val initText: String,
    val machineText: String,
    val detail: String,
)

internal object BridgeUiStateMapper {
    const val GRID_UNKNOWN: String = "—"
    private const val UNKNOWN_MACHINE: String = "Unknown"

    private val usbIds: String =
        "VID ${BikeUsbConstants.VENDOR_ID} PID ${BikeUsbConstants.PRODUCT_ID}"

    fun starting(): BridgeUiState = BridgeUiState(
        UsbPhase.Starting,
        "Starting",
        "Disconnected",
        "Not initialized",
        UNKNOWN_MACHINE,
        "Application starting",
    )

    fun formatStatus(phase: UsbPhase): String = when (phase) {
        UsbPhase.Starting -> "Starting"
        UsbPhase.DeviceNotFound -> "USB device not found"
        UsbPhase.PermissionRequired -> "USB permission required"
        UsbPhase.UsbConnected -> "USB connected"
        UsbPhase.Initializing -> "Initializing"
        UsbPhase.InitializationFailed -> "Initialization failed"
        UsbPhase.Initialized -> "Initialized"
        UsbPhase.Streaming -> "Streaming telemetry"
        UsbPhase.Disconnected -> "Console disconnected"
    }

    fun map(phase: UsbPhase, diagnostic: String, snapshot: NativeTelemetrySnapshot): BridgeUiState {
        val status = formatStatus(phase)
        val machine = snapshot.machine.type.ifEmpty { UNKNOWN_MACHINE }
        return when (phase) {
            UsbPhase.Starting -> starting()
            UsbPhase.DeviceNotFound -> {
                val reason = diagnostic.removePrefix("usb rejected: ")
                if (reason.contains("bootloader")) {
                    BridgeUiState(
                        phase,
                        status,
                        "Bootloader VID ${BikeUsbConstants.VENDOR_ID} PID ${BikeUsbConstants.BOOTLOADER_PRODUCT_ID}",
                        "Not initialized",
                        UNKNOWN_MACHINE,
                        "Brainboard is in bootloader mode. The bridge will not open the bootloader.",
                    )
                } else {
                    BridgeUiState(phase, status, "Not found", "Not initialized", UNKNOWN_MACHINE, reason)
                }
            }
            UsbPhase.PermissionRequired -> BridgeUiState(
                phase,
                status,
                "Permission required ($usbIds)",
                "Not initialized",
                UNKNOWN_MACHINE,
                "USB permission required",
            )
            UsbPhase.UsbConnected -> BridgeUiState(
                phase,
                status,
                "Connected ($usbIds)",
                "Not initialized",
                UNKNOWN_MACHINE,
                "USB interface claimed",
            )
            UsbPhase.Initializing -> BridgeUiState(
                phase,
                status,
                "Connected ($usbIds)",
                "Initializing",
                UNKNOWN_MACHINE,
                "Waiting for primary device",
            )
            UsbPhase.InitializationFailed -> BridgeUiState(
                phase,
                status,
                if (snapshot.connected) "Connected ($usbIds)" else "Disconnected",
                "Initialization failed",
                UNKNOWN_MACHINE,
                diagnostic,
            )
            UsbPhase.Initialized -> BridgeUiState(
                phase,
                status,
                "Connected ($usbIds)",
                "Initialized",
                machine,
                "Primary device ready",
            )
            UsbPhase.Streaming -> BridgeUiState(
                phase,
                status,
                "Connected ($usbIds)",
                "Initialized",
                machine,
                "Streaming native Resistance / RPM / Watts",
            )
            UsbPhase.Disconnected -> BridgeUiState(
                phase,
                status,
                "Disconnected",
                "Disconnected",
                UNKNOWN_MACHINE,
                diagnostic,
            )
        }
    }

    fun statusRow(state: BridgeUiState): String =
        if (state.detail.isNotEmpty() && state.phase != UsbPhase.Streaming) {
            state.statusText + " - " + state.detail
        } else {
            state.statusText
        }

    fun bikeRow(snapshot: NativeTelemetrySnapshot?): String {
        val connected = snapshot != null && snapshot.connected
        val initialized = snapshot != null && snapshot.initialized
        return (if (connected) "Connected" else "Not connected") +
            " / " +
            (if (initialized) "Initialized" else "Not initialized")
    }

    fun controlRow(snapshot: NativeTelemetrySnapshot?): String =
        if (snapshot != null && snapshot.connected && snapshot.initialized && snapshot.machine.canSetResistance) {
            "Available"
        } else {
            "Unavailable"
        }

    fun currentValue(metric: BridgeMetricJson?): Int? =
        if (metric != null && metric.current) metric.value else null

    fun formatGrid(value: Int?): String = value?.toString() ?: GRID_UNKNOWN

    fun gridValueSp(widthPx: Int, heightPx: Int, density: Float, scaledDensity: Float): Float {
        val d = if (density <= 0f) 1f else density
        val scaled = if (scaledDensity <= 0f) d else scaledDensity
        var fromHeight = (heightPx * 0.32f) / d
        if (fromHeight < 56f) fromHeight = 56f
        if (fromHeight > 168f) fromHeight = 168f
        val tileCount = 4
        val dividerCount = 3
        val usablePx = widthPx - dp(16, d) * 2 - dp(1, d) * dividerCount
        if (usablePx < tileCount) return fromHeight
        val maxTextPx = (usablePx / tileCount.toFloat()) * 0.92f
        var fromWidth = (maxTextPx / 1.8f) / scaled
        if (fromWidth < 24f) fromWidth = 24f
        return if (fromWidth < fromHeight) fromWidth else fromHeight
    }

    fun dp(value: Int, density: Float): Int = (value * density + 0.5f).toInt()
}

internal class LanIpv4Candidate(val address: String, val isUp: Boolean, val isLoopback: Boolean)

internal object LanEndpointDisplay {
    const val FALLBACK_ADDRESS: String = "0.0.0.0"

    fun format(port: Int, candidates: List<LanIpv4Candidate> = liveCandidates()): String =
        (selectIpv4(candidates) ?: FALLBACK_ADDRESS) + ":" + port

    fun selectIpv4(candidates: List<LanIpv4Candidate>): String? {
        var linkLocal: String? = null
        for (candidate in candidates) {
            if (!candidate.isUp || candidate.isLoopback) continue
            val octets = parseIpv4(candidate.address) ?: continue
            if (octets[0] == 169 && octets[1] == 254) {
                if (linkLocal == null) linkLocal = candidate.address
                continue
            }
            return candidate.address
        }
        return linkLocal
    }

    private fun parseIpv4(raw: String): IntArray? {
        val parts = raw.split('.')
        if (parts.size != 4) return null
        val out = IntArray(4)
        for (i in 0 until 4) {
            val n = parts[i].toIntOrNull() ?: return null
            if (n < 0 || n > 255) return null
            out[i] = n
        }
        return out
    }

    private fun liveCandidates(): List<LanIpv4Candidate> {
        val list = ArrayList<LanIpv4Candidate>()
        val nics = try {
            NetworkInterface.getNetworkInterfaces()
        } catch (_: Exception) {
            null
        } ?: return list
        for (nic in nics) {
            val up = try {
                nic.isUp
            } catch (_: Exception) {
                false
            }
            val loopback = try {
                nic.isLoopback
            } catch (_: Exception) {
                false
            }
            for (address in nic.inetAddresses) {
                if (address !is Inet4Address) continue
                val host = address.hostAddress ?: continue
                list += LanIpv4Candidate(host, up, loopback || address.isLoopbackAddress)
            }
        }
        return list
    }
}
