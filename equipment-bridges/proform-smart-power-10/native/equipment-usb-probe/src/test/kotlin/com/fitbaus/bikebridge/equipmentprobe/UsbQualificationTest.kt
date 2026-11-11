// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.usb.BikeUsbConstants
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualification
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualificationResult
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class UsbQualificationTest {
    @Test
    fun acceptsExactMatch() {
        val result = UsbQualification.qualify(listOf(matchingBrainboard()))
        assertTrue(result is UsbQualificationResult.Qualified)
    }

    @Test
    fun rejectsMissingDevice() {
        val result = UsbQualification.qualify(emptyList())
        assertTrue(result is UsbQualificationResult.Rejected)
    }

    @Test
    fun rejectsDuplicateDevices() {
        val result = UsbQualification.qualify(listOf(matchingBrainboard("a"), matchingBrainboard("b")))
        assertTrue((result as UsbQualificationResult.Rejected).reason.contains("ambiguous"))
    }

    @Test
    fun rejectsBootloaderPidOnlyForExpectedVendor() {
        val result = UsbQualification.qualify(
            listOf(
                matchingBrainboard(),
                matchingBrainboard(name = "boot", productId = BikeUsbConstants.BOOTLOADER_PRODUCT_ID),
            ),
        )
        assertTrue((result as UsbQualificationResult.Rejected).reason.contains("bootloader"))

        val unrelatedBootloader = UsbQualification.qualify(
            listOf(
                matchingBrainboard(),
                matchingBrainboard(
                    name = "other",
                    vendorId = 0x1234,
                    productId = BikeUsbConstants.BOOTLOADER_PRODUCT_ID,
                ),
            ),
        )
        assertTrue(unrelatedBootloader is UsbQualificationResult.Qualified)
    }

    @Test
    fun rejectsWrongInterfaceClass() {
        val result = UsbQualification.qualify(listOf(matchingBrainboard(interfaceClass = 8)))
        assertTrue((result as UsbQualificationResult.Rejected).reason.contains("interface class"))
    }

    @Test
    fun rejectsWrongEndpointAddresses() {
        val wrongIn = UsbQualification.qualify(listOf(matchingBrainboard(inAddress = 0x83)))
        assertTrue((wrongIn as UsbQualificationResult.Rejected).reason.contains("IN"))
        val wrongOut = UsbQualification.qualify(listOf(matchingBrainboard(outAddress = 0x01)))
        assertTrue((wrongOut as UsbQualificationResult.Rejected).reason.contains("OUT"))
    }

    @Test
    fun rejectsWrongEndpointTypeOrPacketSize() {
        val wrongType = UsbQualification.qualify(listOf(matchingBrainboard(inType = 2)))
        assertTrue(wrongType is UsbQualificationResult.Rejected)
        val wrongSize = UsbQualification.qualify(listOf(matchingBrainboard(packetSize = 32)))
        assertTrue(wrongSize is UsbQualificationResult.Rejected)
    }

    @Test
    fun revalidatesTopologyIndependently() {
        val device = matchingBrainboard()
        assertTrue(UsbQualification.qualifyTopology(device) is UsbQualificationResult.Qualified)
        assertTrue(
            UsbQualification.qualifyTopology(matchingBrainboard(productId = 0x0003)) is UsbQualificationResult.Rejected,
        )
    }
}
