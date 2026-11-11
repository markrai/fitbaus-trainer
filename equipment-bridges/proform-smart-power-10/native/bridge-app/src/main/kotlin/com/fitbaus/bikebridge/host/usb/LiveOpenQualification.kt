// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.usb

/**
 * Requalifies the full USB device list immediately before open/claim.
 * Rejects bootloaders, duplicate normal-mode devices, and topology / name changes.
 */
internal object LiveOpenQualification {
    fun resolve(
        previouslyQualified: UsbQualificationResult.Qualified,
        liveDevices: Collection<UsbDeviceSnapshot>,
    ): LiveOpenResolveResult {
        return when (val live = UsbQualification.qualify(liveDevices)) {
            is UsbQualificationResult.Rejected ->
                LiveOpenResolveResult.Failed("live requalification failed before open: ${live.reason}")
            is UsbQualificationResult.Qualified -> {
                if (live.device != previouslyQualified.device) {
                    LiveOpenResolveResult.Failed(
                        "qualified device snapshot changed before open: " +
                            "expected ${previouslyQualified.device.deviceName} " +
                            "vid=0x${previouslyQualified.device.vendorId.toString(16)}/" +
                            "pid=0x${previouslyQualified.device.productId.toString(16)}, " +
                            "live ${live.device.deviceName} " +
                            "vid=0x${live.device.vendorId.toString(16)}/" +
                            "pid=0x${live.device.productId.toString(16)}",
                    )
                } else {
                    LiveOpenResolveResult.Ready(live)
                }
            }
        }
    }
}

internal sealed class LiveOpenResolveResult {
    data class Ready(val qualified: UsbQualificationResult.Qualified) : LiveOpenResolveResult()
    data class Failed(val reason: String) : LiveOpenResolveResult()
}
