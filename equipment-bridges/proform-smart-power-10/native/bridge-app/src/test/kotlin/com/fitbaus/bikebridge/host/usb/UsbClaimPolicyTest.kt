// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.usb

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.ArrayList

class UsbClaimPolicyTest {
    @Test
    fun permitsForceClaimOnlyForValidatedBrainboard() {
        assertTrue(KernelHidForceClaimPolicy.mayForceClaim(qualifiedBrainboard()))
    }

    @Test
    fun qualificationRejectsBootloaderBeforeAnyClaim() {
        val boot = qualifiedAt(productId = BikeUsbConstants.BOOTLOADER_PRODUCT_ID).device
        val result = UsbQualification.qualify(listOf(boot))
        val rejected = result as UsbQualificationResult.Rejected
        assertTrue(rejected.reason.contains("bootloader"), rejected.reason)
    }

    @Test
    fun refusesBootloaderPid() {
        assertFalse(KernelHidForceClaimPolicy.mayForceClaim(qualifiedAt(productId = BikeUsbConstants.BOOTLOADER_PRODUCT_ID)))
    }

    @Test
    fun refusesOtherVidPidInterfaceAndEndpoints() {
        assertFalse(KernelHidForceClaimPolicy.mayForceClaim(qualifiedAt(vendorId = 0x0483)))
        assertFalse(KernelHidForceClaimPolicy.mayForceClaim(qualifiedAt(productId = 0x0003)))
        assertFalse(KernelHidForceClaimPolicy.mayForceClaim(qualifiedAt(interfaceId = 1)))
        assertFalse(KernelHidForceClaimPolicy.mayForceClaim(qualifiedAt(inAddress = 0x83)))
        assertFalse(KernelHidForceClaimPolicy.mayForceClaim(qualifiedAt(outAddress = 0x01)))
        assertFalse(KernelHidForceClaimPolicy.mayForceClaim(qualifiedAt(interfaceClass = 8)))
    }

    @Test
    fun permittedTargetTriesForceTrueOnlyAfterForceFalseFails() {
        val forces = ArrayList<Boolean>()
        val result = UsbInterfaceClaim.attempt(qualifiedBrainboard()) { force ->
            forces += force
            force
        }
        assertEquals(listOf(false, true), forces)
        assertEquals(UsbInterfaceClaimResult.Claimed(usedForce = true), result)
    }

    @Test
    fun permittedTargetDoesNotForceIfUnforcedClaimSucceeds() {
        val forces = ArrayList<Boolean>()
        val result = UsbInterfaceClaim.attempt(qualifiedBrainboard()) { force ->
            forces += force
            true
        }
        assertEquals(listOf(false), forces)
        assertEquals(UsbInterfaceClaimResult.Claimed(usedForce = false), result)
    }

    @Test
    fun prohibitedTargetsNeverReceiveForceTrue() {
        val prohibited = listOf(
            qualifiedAt(productId = BikeUsbConstants.BOOTLOADER_PRODUCT_ID),
            qualifiedAt(vendorId = 0x0483),
            qualifiedAt(productId = 0x0003),
            qualifiedAt(interfaceId = 1),
        )
        for (target in prohibited) {
            val forces = ArrayList<Boolean>()
            val result = UsbInterfaceClaim.attempt(target) { force ->
                forces += force
                false
            }
            assertEquals(listOf(false), forces, "force=true was invoked for $target")
            val failed = result as UsbInterfaceClaimResult.Failed
            assertFalse(failed.retryable)
            assertTrue(failed.reason.contains("force-claim not permitted"), failed.reason)
        }
    }

    @Test
    fun bothClaimAttemptsFailIsTerminalNotRetryable() {
        val forces = ArrayList<Boolean>()
        val result = UsbInterfaceClaim.attempt(qualifiedBrainboard()) { force ->
            forces += force
            false
        }
        assertEquals(listOf(false, true), forces)
        val failed = result as UsbInterfaceClaimResult.Failed
        assertFalse(failed.retryable)
        assertTrue(failed.reason.contains("claimInterface(force=true)"), failed.reason)
        assertTrue(failed.reason.contains("not retrying"), failed.reason)
    }

    @Test
    fun cleanupReleasesThenCloses() {
        val order = ArrayList<String>()
        UsbClaimedResource.release(
            releaseInterface = {
                order += "release"
                true
            },
            closeConnection = { order += "close" },
            warn = { error("unexpected warn: $it") },
        )
        assertEquals(listOf("release", "close"), order)
    }

    @Test
    fun cleanupClosesAndReportsWhenReleaseFails() {
        val order = ArrayList<String>()
        val warnings = ArrayList<String>()
        UsbClaimedResource.release(
            releaseInterface = {
                order += "release"
                false
            },
            closeConnection = { order += "close" },
            warn = { warnings += it },
        )
        assertEquals(listOf("release", "close"), order)
        assertEquals(listOf("releaseInterface returned false"), warnings)
    }

    @Test
    fun cleanupStillClosesWhenReleaseThrows() {
        val order = ArrayList<String>()
        val warnings = ArrayList<String>()
        UsbClaimedResource.release(
            releaseInterface = {
                order += "release"
                throw IllegalStateException("claimed lock")
            },
            closeConnection = { order += "close" },
            warn = { warnings += it },
        )
        assertEquals(listOf("release", "close"), order)
        assertTrue(warnings.single().contains("releaseInterface failed: claimed lock"), warnings.toString())
    }

    @Test
    fun cleanupReportsCloseFailureAfterRelease() {
        val warnings = ArrayList<String>()
        UsbClaimedResource.release(
            releaseInterface = { true },
            closeConnection = { throw IllegalStateException("fd") },
            warn = { warnings += it },
        )
        assertTrue(warnings.single().contains("connection.close failed: fd"), warnings.toString())
    }

    private fun qualifiedBrainboard(): UsbQualificationResult.Qualified =
        qualifiedAt()

    private fun qualifiedAt(
        vendorId: Int = BikeUsbConstants.VENDOR_ID,
        productId: Int = BikeUsbConstants.PRODUCT_ID,
        interfaceId: Int = BikeUsbConstants.INTERFACE_NUMBER,
        interfaceClass: Int = BikeUsbConstants.INTERFACE_CLASS_HID,
        inAddress: Int = BikeUsbConstants.IN_ENDPOINT_ADDRESS,
        outAddress: Int = BikeUsbConstants.OUT_ENDPOINT_ADDRESS,
    ): UsbQualificationResult.Qualified {
        val iface = UsbInterfaceSnapshot(
            id = interfaceId,
            interfaceClass = interfaceClass,
            endpoints = listOf(
                UsbEndpointSnapshot(
                    inAddress,
                    directionIn = true,
                    type = BikeUsbConstants.ENDPOINT_TYPE_INTERRUPT,
                    maxPacketSize = BikeUsbConstants.PACKET_SIZE,
                ),
                UsbEndpointSnapshot(
                    outAddress,
                    directionIn = false,
                    type = BikeUsbConstants.ENDPOINT_TYPE_INTERRUPT,
                    maxPacketSize = BikeUsbConstants.PACKET_SIZE,
                ),
            ),
        )
        val inEp = iface.endpoints.first { it.directionIn }
        val outEp = iface.endpoints.first { !it.directionIn }
        return UsbQualificationResult.Qualified(
            device = UsbDeviceSnapshot(
                deviceName = "bike0",
                vendorId = vendorId,
                productId = productId,
                interfaces = listOf(iface),
            ),
            usbInterface = iface,
            inEndpoint = inEp,
            outEndpoint = outEp,
        )
    }
}
