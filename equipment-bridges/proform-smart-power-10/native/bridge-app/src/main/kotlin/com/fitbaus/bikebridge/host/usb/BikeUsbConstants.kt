// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.usb

internal object BikeUsbConstants {
    const val VENDOR_ID: Int = 0x213C
    const val PRODUCT_ID: Int = 0x0002
    const val BOOTLOADER_PRODUCT_ID: Int = 0x0099
    const val INTERFACE_NUMBER: Int = 0
    const val INTERFACE_CLASS_HID: Int = 3
    const val IN_ENDPOINT_ADDRESS: Int = 0x81
    const val OUT_ENDPOINT_ADDRESS: Int = 0x02
    const val PACKET_SIZE: Int = 64
    const val ENDPOINT_TYPE_INTERRUPT: Int = 3
}
