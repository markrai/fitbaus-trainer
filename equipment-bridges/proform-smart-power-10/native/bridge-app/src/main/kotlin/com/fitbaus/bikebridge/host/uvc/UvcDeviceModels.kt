// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import com.fitbaus.arcade.AuthorizedCameraFd
import com.fitbaus.bikebridge.host.usb.BikeUsbConstants

/** Testable snapshot of a USB device; no Android USB types. */
internal data class UvcDeviceInfo(
    val deviceName: String,
    val vendorId: Int,
    val productId: Int,
    val serial: String?,
    val hasVideoControl: Boolean,
    val hasVideoStreaming: Boolean,
) {
    /**
     * Stable across pre-/post-permission serial visibility. Serial may be unavailable before
     * grant (SecurityException), so identity must not flip when serial appears.
     */
    val key: String
        get() = String.format("%04x:%04x", vendorId and 0xffff, productId and 0xffff)
}

/** Host USB surface used by [UvcCameraHost]; faked in unit tests. */
internal interface UvcUsbGateway : AutoCloseable {
    fun listDevices(): Collection<UvcDeviceInfo>
    fun hasPermission(deviceName: String): Boolean
    fun requestPermission(deviceName: String)
    fun openDevice(deviceName: String): AuthorizedCameraFd?
    fun setListener(listener: Listener?)

    /** Unregister receivers / drop callbacks. Idempotent. */
    override fun close()

    interface Listener {
        fun onPermissionBroadcast(deviceName: String, extraGranted: Boolean)
        fun onDeviceDetached(deviceName: String)
    }
}

/** Pure selection rules for the external webcam path. */
internal object UvcDeviceSelector {
    const val C270_VID: Int = 0x046d
    const val C270_PID: Int = 0x0825
    const val ONBOARD_VID: Int = 0x2d27
    const val ONBOARD_PID: Int = 0x1751
    const val BIKE_ANDROID_VID: Int = 0x8508
    const val BIKE_ANDROID_PID: Int = 0x0002

    fun isForbidden(vid: Int, pid: Int): Boolean {
        if (vid == BikeUsbConstants.VENDOR_ID &&
            (pid == BikeUsbConstants.PRODUCT_ID || pid == BikeUsbConstants.BOOTLOADER_PRODUCT_ID)
        ) {
            return true
        }
        if (vid == BIKE_ANDROID_VID && pid == BIKE_ANDROID_PID) return true
        if (vid == ONBOARD_VID && pid == ONBOARD_PID) return true
        return false
    }

    fun isC270(vid: Int, pid: Int): Boolean = vid == C270_VID && pid == C270_PID

    fun select(devices: Collection<UvcDeviceInfo>): UvcDeviceInfo? {
        for (device in devices) {
            if (isForbidden(device.vendorId, device.productId)) continue
            if (!isC270(device.vendorId, device.productId)) continue
            if (!device.hasVideoControl || !device.hasVideoStreaming) continue
            return device
        }
        return null
    }
}
