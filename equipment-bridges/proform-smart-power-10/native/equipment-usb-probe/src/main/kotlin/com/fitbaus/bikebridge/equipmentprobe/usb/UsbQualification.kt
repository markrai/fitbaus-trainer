// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.usb

internal object UsbQualification {
    fun qualify(devices: Collection<UsbDeviceSnapshot>): UsbQualificationResult {
        val vendorBootloaders = devices.filter {
            it.vendorId == BikeUsbConstants.VENDOR_ID &&
                it.productId == BikeUsbConstants.BOOTLOADER_PRODUCT_ID
        }
        if (vendorBootloaders.isNotEmpty()) {
            return UsbQualificationResult.Rejected(
                "bootloader PID 0x${BikeUsbConstants.BOOTLOADER_PRODUCT_ID.toString(16)} " +
                    "for VID 0x${BikeUsbConstants.VENDOR_ID.toString(16)} present; opening refused",
            )
        }

        val matches = devices.filter {
            it.vendorId == BikeUsbConstants.VENDOR_ID && it.productId == BikeUsbConstants.PRODUCT_ID
        }
        if (matches.isEmpty()) {
            return UsbQualificationResult.Rejected("no normal-mode brainboard device found")
        }
        if (matches.size > 1) {
            return UsbQualificationResult.Rejected("ambiguous topology: ${matches.size} matching devices")
        }

        return qualifyTopology(matches.single())
    }

    fun qualifyTopology(device: UsbDeviceSnapshot): UsbQualificationResult {
        if (device.vendorId != BikeUsbConstants.VENDOR_ID || device.productId != BikeUsbConstants.PRODUCT_ID) {
            return UsbQualificationResult.Rejected("device VID/PID mismatch before open")
        }
        val iface = device.interfaces.firstOrNull { it.id == BikeUsbConstants.INTERFACE_NUMBER }
            ?: return UsbQualificationResult.Rejected("interface ${BikeUsbConstants.INTERFACE_NUMBER} missing")

        if (iface.interfaceClass != BikeUsbConstants.INTERFACE_CLASS_HID) {
            return UsbQualificationResult.Rejected(
                "interface class ${iface.interfaceClass} is not HID class ${BikeUsbConstants.INTERFACE_CLASS_HID}",
            )
        }

        val inEndpoint = iface.endpoints.firstOrNull {
            it.directionIn &&
                it.address == BikeUsbConstants.IN_ENDPOINT_ADDRESS &&
                it.type == BikeUsbConstants.ENDPOINT_TYPE_INTERRUPT &&
                it.maxPacketSize == BikeUsbConstants.PACKET_SIZE
        } ?: return UsbQualificationResult.Rejected(
            "interrupt IN endpoint 0x${BikeUsbConstants.IN_ENDPOINT_ADDRESS.toString(16)} / 64 B missing or mismatched",
        )

        val outEndpoint = iface.endpoints.firstOrNull {
            !it.directionIn &&
                it.address == BikeUsbConstants.OUT_ENDPOINT_ADDRESS &&
                it.type == BikeUsbConstants.ENDPOINT_TYPE_INTERRUPT &&
                it.maxPacketSize == BikeUsbConstants.PACKET_SIZE
        } ?: return UsbQualificationResult.Rejected(
            "interrupt OUT endpoint 0x${BikeUsbConstants.OUT_ENDPOINT_ADDRESS.toString(16)} / 64 B missing or mismatched",
        )

        return UsbQualificationResult.Qualified(device, iface, inEndpoint, outEndpoint)
    }
}
