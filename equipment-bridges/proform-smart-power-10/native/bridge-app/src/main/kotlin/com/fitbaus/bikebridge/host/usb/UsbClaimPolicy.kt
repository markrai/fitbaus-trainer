// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.usb

/**
 * Kernel-HID force-claim is allowed only for the already-qualified normal-mode
 * ICON brainboard. It detaches usbhid/hid-generic on that one interface.
 * It is not permission to open any other device or to displace another app.
 */
internal object KernelHidForceClaimPolicy {
    fun mayForceClaim(qualified: UsbQualificationResult.Qualified): Boolean {
        val device = qualified.device
        if (device.vendorId != BikeUsbConstants.VENDOR_ID) return false
        if (device.productId == BikeUsbConstants.BOOTLOADER_PRODUCT_ID) return false
        if (device.productId != BikeUsbConstants.PRODUCT_ID) return false
        if (qualified.usbInterface.id != BikeUsbConstants.INTERFACE_NUMBER) return false
        return when (val topology = UsbQualification.qualifyTopology(device)) {
            is UsbQualificationResult.Rejected -> false
            is UsbQualificationResult.Qualified ->
                topology.usbInterface.id == BikeUsbConstants.INTERFACE_NUMBER &&
                    topology.inEndpoint.address == BikeUsbConstants.IN_ENDPOINT_ADDRESS &&
                    topology.outEndpoint.address == BikeUsbConstants.OUT_ENDPOINT_ADDRESS
        }
    }
}

internal sealed class UsbInterfaceClaimResult {
    data class Claimed(val usedForce: Boolean) : UsbInterfaceClaimResult()
    data class Failed(val reason: String, val retryable: Boolean) : UsbInterfaceClaimResult()
}

/**
 * Tries [claimInterface](force=false) first. [force]=true is invoked only when
 * [KernelHidForceClaimPolicy] permits this exact brainboard. Claim failures are
 * not treated as detach/reconnect.
 */
internal object UsbInterfaceClaim {
    fun attempt(
        qualified: UsbQualificationResult.Qualified,
        claimInterface: (force: Boolean) -> Boolean,
    ): UsbInterfaceClaimResult {
        if (claimInterface(false)) {
            return UsbInterfaceClaimResult.Claimed(usedForce = false)
        }
        if (!KernelHidForceClaimPolicy.mayForceClaim(qualified)) {
            return UsbInterfaceClaimResult.Failed(
                reason = "claimInterface(force=false) failed; force-claim not permitted for this USB target",
                retryable = false,
            )
        }
        if (claimInterface(true)) {
            return UsbInterfaceClaimResult.Claimed(usedForce = true)
        }
        return UsbInterfaceClaimResult.Failed(
            reason = "claimInterface(force=true) failed for qualified 0x213C:0x0002 interface 0; not retrying",
            retryable = false,
        )
    }
}

/** Always [releaseInterface] then [close] after a successful claim. */
internal object UsbClaimedResource {
    fun release(
        releaseInterface: () -> Boolean,
        closeConnection: () -> Unit,
        warn: (String) -> Unit,
    ) {
        try {
            if (!releaseInterface()) {
                warn("releaseInterface returned false")
            }
        } catch (ex: Exception) {
            warn("releaseInterface failed: ${ex.message ?: ex.javaClass.simpleName}")
        }
        try {
            closeConnection()
        } catch (ex: Exception) {
            warn("connection.close failed: ${ex.message ?: ex.javaClass.simpleName}")
        }
    }
}
