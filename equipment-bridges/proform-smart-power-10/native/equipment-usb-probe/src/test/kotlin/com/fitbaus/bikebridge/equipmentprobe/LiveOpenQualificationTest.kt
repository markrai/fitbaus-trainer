// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.usb.BikeUsbConstants
import com.fitbaus.bikebridge.equipmentprobe.usb.LiveOpenQualification
import com.fitbaus.bikebridge.equipmentprobe.usb.LiveOpenResolveResult
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualification
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualificationResult
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class LiveOpenQualificationTest {
    @Test
    fun acceptsUnchangedSingleQualifiedDevice() {
        val device = matchingBrainboard("bike0")
        val prior = UsbQualification.qualify(listOf(device)) as UsbQualificationResult.Qualified
        val result = LiveOpenQualification.resolve(prior, listOf(device))
        assertTrue(result is LiveOpenResolveResult.Ready)
    }

    @Test
    fun rejectsDuplicateNormalModeDevicesAppearingBeforeOpen() {
        val prior = UsbQualification.qualify(listOf(matchingBrainboard("bike0"))) as UsbQualificationResult.Qualified
        val result = LiveOpenQualification.resolve(
            prior,
            listOf(matchingBrainboard("bike0"), matchingBrainboard("bike1")),
        )
        assertTrue((result as LiveOpenResolveResult.Failed).reason.contains("ambiguous"))
    }

    @Test
    fun rejectsBootloaderAppearingBeforeOpen() {
        val prior = UsbQualification.qualify(listOf(matchingBrainboard("bike0"))) as UsbQualificationResult.Qualified
        val result = LiveOpenQualification.resolve(
            prior,
            listOf(
                matchingBrainboard("bike0"),
                matchingBrainboard(name = "boot", productId = BikeUsbConstants.BOOTLOADER_PRODUCT_ID),
            ),
        )
        assertTrue((result as LiveOpenResolveResult.Failed).reason.contains("bootloader"))
    }

    @Test
    fun rejectsDeviceNameChangeBeforeOpen() {
        val prior = UsbQualification.qualify(listOf(matchingBrainboard("bike0"))) as UsbQualificationResult.Qualified
        val result = LiveOpenQualification.resolve(prior, listOf(matchingBrainboard("bike-renamed")))
        assertTrue((result as LiveOpenResolveResult.Failed).reason.contains("changed before open"))
    }

    @Test
    fun rejectsTopologyChangeOnSameDeviceName() {
        val prior = UsbQualification.qualify(listOf(matchingBrainboard("bike0"))) as UsbQualificationResult.Qualified
        val result = LiveOpenQualification.resolve(
            prior,
            listOf(matchingBrainboard("bike0", packetSize = 32)),
        )
        // Packet-size mismatch fails live requalification — open must not proceed by name alone.
        assertTrue(result is LiveOpenResolveResult.Failed)
        assertTrue((result as LiveOpenResolveResult.Failed).reason.contains("live requalification failed"))
    }
}
