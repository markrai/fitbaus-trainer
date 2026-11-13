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
     * Attachment-scoped identity available before USB permission.
     * Includes bus path so two devices that share a VID/PID stay distinct; omits serial so the
     * key does not flip when serial becomes readable after grant.
     */
    val key: String
        get() = String.format(
            "%04x:%04x:%s",
            vendorId and 0xffff,
            productId and 0xffff,
            deviceName,
        )
}

/** Host USB surface used by [UvcCameraHost]; faked in unit tests. */
internal interface UvcUsbGateway : AutoCloseable {
    fun listDevices(): Collection<UvcDeviceInfo>
    fun hasPermission(deviceName: String): Boolean
    /**
     * Fire a USB permission prompt tagged with [requestId].
     * Returns false when no prompt was dispatched (gateway closed or device gone).
     * The matching broadcast must echo the same id so stale results cannot authorize a later plug.
     */
    fun requestPermission(deviceName: String, requestId: Long): Boolean
    fun openDevice(deviceName: String): AuthorizedCameraFd?
    fun setListener(listener: Listener?)

    /** Unregister receivers / drop callbacks. Idempotent. */
    override fun close()

    interface Listener {
        fun onPermissionBroadcast(deviceName: String, extraGranted: Boolean, requestId: Long)
        fun onDeviceDetached(deviceName: String)
    }
}

/**
 * Selects an external standards-compliant UVC webcam by interface class, not model whitelist.
 * Deterministic when several candidates are present (lexicographic [UvcDeviceInfo.deviceName]).
 */
internal object UvcDeviceSelector {
    /** Fixtures / docs only — never used as an allowlist. */
    const val C270_VID: Int = 0x046d
    const val C270_PID: Int = 0x0825
    const val PRO9000_VID: Int = 0x046d
    const val PRO9000_PID: Int = 0x0990
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

    fun isExternalUvc(device: UvcDeviceInfo): Boolean {
        if (isForbidden(device.vendorId, device.productId)) return false
        return device.hasVideoControl && device.hasVideoStreaming
    }

    fun select(devices: Collection<UvcDeviceInfo>): UvcDeviceInfo? =
        devices
            .asSequence()
            .filter(::isExternalUvc)
            .sortedBy { it.deviceName }
            .firstOrNull()
}
