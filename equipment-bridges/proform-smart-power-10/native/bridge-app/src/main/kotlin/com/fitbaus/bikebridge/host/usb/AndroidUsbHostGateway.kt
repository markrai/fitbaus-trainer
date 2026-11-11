// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.usb

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.util.Log
import com.fitbaus.bikebridge.host.HostConstants
import com.fitbaus.bikebridge.host.policy.ReadOnlyTransmitGate
import com.fitbaus.bikebridge.host.policy.TransmitAllowlist
import com.fitbaus.bikebridge.host.policy.TransmitDecision

internal class AndroidUsbHostGateway(
    private val usbManager: UsbManager,
) : UsbHostGateway {
    fun deviceForName(deviceName: String): UsbDevice? =
        usbManager.deviceList.values.firstOrNull { it.deviceName == deviceName }

    override fun listDevices(): List<UsbDeviceSnapshot> =
        usbManager.deviceList.values.map { snapshot(it) }

    override fun hasPermission(deviceName: String): Boolean {
        val device = deviceForName(deviceName) ?: return false
        return usbManager.hasPermission(device)
    }

    override fun openQualified(qualified: UsbQualificationResult.Qualified): OpenResult {
        val liveList = listDevices()
        val resolved = when (val liveQualify = LiveOpenQualification.resolve(qualified, liveList)) {
            is LiveOpenResolveResult.Failed -> return OpenResult.Failed(liveQualify.reason)
            is LiveOpenResolveResult.Ready -> liveQualify.qualified
        }
        // Open the UsbDevice whose full snapshot equals the requalified device.
        // Do not resolve by name alone — that can select a different topology under
        // the same path string after a bus change.
        val live = findDeviceMatchingSnapshot(resolved.device)
            ?: return OpenResult.Failed("qualified device snapshot no longer present on the bus")
        val liveSnapshot = snapshot(live)
        if (liveSnapshot != resolved.device) {
            return OpenResult.Failed("opened device snapshot diverged from live qualification")
        }
        if (!usbManager.hasPermission(live)) {
            return OpenResult.Failed("USB permission not granted")
        }
        val connection = usbManager.openDevice(live)
            ?: return OpenResult.Failed("openDevice returned null")
        val usbInterface = live.getInterface(resolved.usbInterface.id)
            ?: run {
                connection.close()
                return OpenResult.Failed("interface ${resolved.usbInterface.id} unavailable")
            }

        when (val claimed = UsbInterfaceClaim.attempt(resolved) { force ->
            connection.claimInterface(usbInterface, force)
        }) {
            is UsbInterfaceClaimResult.Failed -> {
                connection.close()
                return OpenResult.Failed(reason = claimed.reason, retryable = claimed.retryable)
            }
            is UsbInterfaceClaimResult.Claimed -> {
                if (claimed.usedForce) {
                    Log.i(
                        HostConstants.LOG_TAG,
                        "claimInterface(force=true) for qualified 0x213C:0x0002 interface 0",
                    )
                }
            }
        }

        val inEndpoint = resolveEndpoint(usbInterface, BikeUsbConstants.IN_ENDPOINT_ADDRESS, directionIn = true)
        val outEndpoint = resolveEndpoint(usbInterface, BikeUsbConstants.OUT_ENDPOINT_ADDRESS, directionIn = false)
        if (inEndpoint == null || outEndpoint == null) {
            UsbClaimedResource.release(
                releaseInterface = { connection.releaseInterface(usbInterface) },
                closeConnection = { connection.close() },
                warn = { Log.w(HostConstants.LOG_TAG, it) },
            )
            return OpenResult.Failed(
                reason = "resolved endpoints missing after claim",
                retryable = false,
            )
        }

        val allowlist = TransmitAllowlist()
        val raw = AndroidProbeTransport(
            connection = connection,
            usbInterface = usbInterface,
            inEndpoint = inEndpoint,
            outEndpoint = outEndpoint,
            allowlist = allowlist,
            attachedCheck = { usbManager.deviceList.containsKey(live.deviceName) },
        )
        return OpenResult.Opened(ValidatedProbeTransport(raw, allowlist))
    }

    private fun findDeviceMatchingSnapshot(expected: UsbDeviceSnapshot): UsbDevice? =
        usbManager.deviceList.values.firstOrNull { snapshot(it) == expected }

    companion object {
        fun snapshot(device: UsbDevice): UsbDeviceSnapshot {
            val interfaces = ArrayList<UsbInterfaceSnapshot>()
            for (i in 0 until device.interfaceCount) {
                val iface = device.getInterface(i)
                val endpoints = ArrayList<UsbEndpointSnapshot>()
                for (e in 0 until iface.endpointCount) {
                    val ep = iface.getEndpoint(e)
                    endpoints += UsbEndpointSnapshot(
                        address = ep.address,
                        directionIn = ep.direction == UsbConstants.USB_DIR_IN,
                        type = ep.type,
                        maxPacketSize = ep.maxPacketSize,
                    )
                }
                interfaces += UsbInterfaceSnapshot(
                    id = iface.id,
                    interfaceClass = iface.interfaceClass,
                    endpoints = endpoints,
                )
            }
            return UsbDeviceSnapshot(
                deviceName = device.deviceName,
                vendorId = device.vendorId,
                productId = device.productId,
                interfaces = interfaces,
            )
        }

        private fun resolveEndpoint(
            usbInterface: UsbInterface,
            address: Int,
            directionIn: Boolean,
        ): UsbEndpoint? {
            for (i in 0 until usbInterface.endpointCount) {
                val ep = usbInterface.getEndpoint(i)
                val isIn = ep.direction == UsbConstants.USB_DIR_IN
                if (ep.address == address && isIn == directionIn && ep.type == UsbConstants.USB_ENDPOINT_XFER_INT) {
                    return ep
                }
            }
            return null
        }
    }
}

internal class AndroidProbeTransport(
    private val connection: UsbDeviceConnection,
    private val usbInterface: UsbInterface,
    private val inEndpoint: UsbEndpoint,
    private val outEndpoint: UsbEndpoint,
    private val allowlist: TransmitAllowlist,
    private val attachedCheck: () -> Boolean,
) : ProbeTransport {
    @Volatile
    private var closed: Boolean = false

    var outTransfers: Int = 0
        private set

    override fun transmitAllowlist(): TransmitAllowlist = allowlist

    override fun isAttached(): Boolean = !closed && attachedCheck()

    override fun exchange(request: ByteArray): TransportResult {
        if (closed) return TransportResult.Failed(TransportFailureClass.DETACHED_BEFORE_OUT)
        if (!attachedCheck()) return TransportResult.Failed(TransportFailureClass.DETACHED_BEFORE_OUT)

        when (val decision = ReadOnlyTransmitGate.validateOutgoing(request, allowlist.state())) {
            is TransmitDecision.Reject -> {
                return TransportResult.Failed(TransportFailureClass.POLICY_REJECTED)
            }
            TransmitDecision.Allow -> Unit
        }

        outTransfers += 1
        val written = connection.bulkTransfer(
            outEndpoint,
            request,
            request.size,
            HostConstants.OUT_TIMEOUT_MS,
        )
        if (written < 0) {
            return TransportResult.Failed(TransportFailureClass.OUT_TRANSFER_FAILED)
        }
        if (written != request.size) {
            return TransportResult.Failed(TransportFailureClass.PARTIAL_OUT_WRITE)
        }

        val buffer = ByteArray(BikeUsbConstants.PACKET_SIZE)
        val read = connection.bulkTransfer(
            inEndpoint,
            buffer,
            buffer.size,
            HostConstants.IN_TIMEOUT_MS,
        )
        if (read < 0) {
            return TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE)
        }
        if (read == 0) {
            return TransportResult.Ok(null)
        }
        return TransportResult.Ok(buffer.copyOf(read))
    }

    override fun close() {
        if (closed) return
        closed = true
        UsbClaimedResource.release(
            releaseInterface = { connection.releaseInterface(usbInterface) },
            closeConnection = { connection.close() },
            warn = { Log.w(HostConstants.LOG_TAG, it) },
        )
    }
}
