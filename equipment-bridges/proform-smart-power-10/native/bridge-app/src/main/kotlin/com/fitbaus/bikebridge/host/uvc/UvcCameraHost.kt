// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import android.util.Log
import com.fitbaus.arcade.AuthorizedCameraFd
import com.fitbaus.arcade.ExternalCameraProvider

/**
 * USB Host owner for the verified Logitech C270.
 *
 * [openAuthorizedCamera] never blocks waiting for a permission dialog.
 * Existing authorization opens immediately; first-time prompts are fired asynchronously and the
 * caller falls back to Camera1 until a later game enter after grant. Denial is sticky until detach.
 *
 * Map mutations are synchronized; USB Host calls run outside the lock.
 */
internal class UvcCameraHost(
    private val gateway: UvcUsbGateway,
    private val machine: UvcPermissionMachine = UvcPermissionMachine(),
) : ExternalCameraProvider, AutoCloseable {
    private val lock = Any()
    private val keysByDeviceName = HashMap<String, String>()
    /** deviceName that currently has an outstanding permission request (stable key tracked separately). */
    private var pendingRequestDeviceName: String? = null
    private var closed = false

    constructor(appContext: android.content.Context) : this(AndroidUvcUsbGateway(appContext))

    init {
        gateway.setListener(object : UvcUsbGateway.Listener {
            override fun onPermissionBroadcast(deviceName: String, extraGranted: Boolean) {
                handlePermissionBroadcast(deviceName, extraGranted)
            }

            override fun onDeviceDetached(deviceName: String) {
                handleDetach(deviceName)
            }
        })
    }

    override fun openAuthorizedCamera(): AuthorizedCameraFd? {
        if (closed) return null
        val device = UvcDeviceSelector.select(gateway.listDevices()) ?: return null
        val hasPerm = gateway.hasPermission(device.deviceName)
        val action = synchronized(lock) {
            keysByDeviceName[device.deviceName] = device.key
            machine.onOpenAttempt(device.key, hasPerm)
        }
        return when (action) {
            UvcPermissionAction.OpenNow -> {
                if (!gateway.hasPermission(device.deviceName)) {
                    synchronized(lock) { machine.onPermissionResult(device.key, false) }
                    null
                } else {
                    gateway.openDevice(device.deviceName)
                }
            }
            UvcPermissionAction.FallbackNoPrompt -> null
            UvcPermissionAction.RequestThenFallback -> {
                synchronized(lock) { pendingRequestDeviceName = device.deviceName }
                try {
                    gateway.requestPermission(device.deviceName)
                } catch (t: Throwable) {
                    Log.e(TAG, "requestPermission failed", t)
                    synchronized(lock) {
                        if (pendingRequestDeviceName == device.deviceName) pendingRequestDeviceName = null
                        machine.onRequestFailed(device.key)
                    }
                }
                null
            }
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        synchronized(lock) {
            pendingRequestDeviceName = null
            keysByDeviceName.clear()
            machine.clear()
        }
        try {
            gateway.setListener(null)
            gateway.close()
        } catch (t: Throwable) {
            Log.e(TAG, "gateway close failed", t)
        }
    }

    internal fun phaseForTest(deviceKey: String): UvcPermissionPhase = machine.phase(deviceKey)

    private fun handlePermissionBroadcast(deviceName: String, extraGranted: Boolean) {
        if (closed) return
        val device = gateway.listDevices().firstOrNull { it.deviceName == deviceName }
        val rememberedKey: String?
        val pending: String?
        synchronized(lock) {
            pending = pendingRequestDeviceName
            rememberedKey = keysByDeviceName[deviceName]
            if (device != null) keysByDeviceName[deviceName] = device.key
        }
        val key = device?.key ?: rememberedKey ?: return
        val isC270 = if (device != null) {
            UvcDeviceSelector.isC270(device.vendorId, device.productId)
        } else {
            key == C270_KEY
        }
        if (!isC270) return
        if (pending != null && pending != deviceName) {
            Log.i(TAG, "ignoring stale permission broadcast for $deviceName pending=$pending")
            return
        }
        val live = gateway.hasPermission(deviceName)
        val phase = machine.onPermissionResult(key, live)
        synchronized(lock) {
            if (pendingRequestDeviceName == deviceName) pendingRequestDeviceName = null
        }
        Log.i(TAG, "permission result device=$deviceName extraGranted=$extraGranted live=$live phase=$phase key=$key")
    }

    private fun handleDetach(deviceName: String) {
        if (closed) return
        val key = synchronized(lock) {
            if (pendingRequestDeviceName == deviceName) pendingRequestDeviceName = null
            keysByDeviceName.remove(deviceName)
        }
        if (key != null) {
            machine.onDetached(key)
        } else {
            // Only one C270 is ever tracked; clear its phase if the name map was already empty.
            machine.onDetached(C270_KEY)
        }
        Log.i(TAG, "uvc detached name=$deviceName key=$key")
    }

    companion object {
        private const val TAG = "FitbausUvcHost"
        private val C270_KEY: String =
            String.format("%04x:%04x", UvcDeviceSelector.C270_VID and 0xffff, UvcDeviceSelector.C270_PID and 0xffff)
    }
}
