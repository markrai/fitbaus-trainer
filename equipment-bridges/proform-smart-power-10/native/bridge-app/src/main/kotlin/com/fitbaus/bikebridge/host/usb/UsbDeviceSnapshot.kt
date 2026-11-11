// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.usb

internal data class UsbEndpointSnapshot(
    val address: Int,
    val directionIn: Boolean,
    val type: Int,
    val maxPacketSize: Int,
)

internal data class UsbInterfaceSnapshot(
    val id: Int,
    val interfaceClass: Int,
    val endpoints: List<UsbEndpointSnapshot>,
)

internal data class UsbDeviceSnapshot(
    val deviceName: String,
    val vendorId: Int,
    val productId: Int,
    val interfaces: List<UsbInterfaceSnapshot>,
)

internal sealed class UsbQualificationResult {
    data class Qualified(
        val device: UsbDeviceSnapshot,
        val usbInterface: UsbInterfaceSnapshot,
        val inEndpoint: UsbEndpointSnapshot,
        val outEndpoint: UsbEndpointSnapshot,
    ) : UsbQualificationResult()

    data class Rejected(val reason: String) : UsbQualificationResult()
}
