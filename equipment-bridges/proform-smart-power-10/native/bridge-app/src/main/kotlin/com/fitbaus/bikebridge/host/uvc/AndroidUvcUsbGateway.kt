// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Log
import com.fitbaus.arcade.AuthorizedCameraFd

internal class AndroidUvcUsbGateway(
    context: Context,
    private val usbManager: UsbManager = context.applicationContext.getSystemService(Context.USB_SERVICE) as UsbManager,
) : UvcUsbGateway {
    private val appContext = context.applicationContext
    private val registerLock = Any()

    @Volatile
    private var listener: UvcUsbGateway.Listener? = null

    @Volatile
    private var closed = false
    private var registered = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (closed) return
            val current = listener ?: return
            when (intent.action) {
                ACTION_USB_PERMISSION -> {
                    @Suppress("DEPRECATION")
                    val device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE) as UsbDevice? ?: return
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    val requestId = intent.getLongExtra(EXTRA_REQUEST_ID, NO_REQUEST_ID)
                    current.onPermissionBroadcast(device.deviceName, granted, requestId)
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    @Suppress("DEPRECATION")
                    val device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE) as UsbDevice? ?: return
                    current.onDeviceDetached(device.deviceName)
                }
            }
        }
    }

    override fun listDevices(): Collection<UvcDeviceInfo> =
        usbManager.deviceList.values.map { it.toInfo() }

    override fun hasPermission(deviceName: String): Boolean {
        val device = usbManager.deviceList[deviceName] ?: return false
        return usbManager.hasPermission(device)
    }

    override fun requestPermission(deviceName: String, requestId: Long): Boolean {
        if (closed) return false
        val device = usbManager.deviceList[deviceName] ?: return false
        ensureRegistered()
        val intent = Intent(ACTION_USB_PERMISSION).setPackage(appContext.packageName)
        intent.putExtra(EXTRA_REQUEST_ID, requestId)
        val flags = if (Build.VERSION.SDK_INT >= 31) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        // Full requestId bits in requestCode so Activity-recreation IDs stay distinct in the PI table.
        val requestCode = (requestId xor (requestId ushr 32)).toInt()
        val pi = PendingIntent.getBroadcast(appContext, requestCode, intent, flags)
        usbManager.requestPermission(device, pi)
        return true
    }

    override fun openDevice(deviceName: String): AuthorizedCameraFd? {
        if (closed) return null
        val device = usbManager.deviceList[deviceName] ?: return null
        if (!usbManager.hasPermission(device)) return null
        val connection = usbManager.openDevice(device) ?: return null
        if (connection.fileDescriptor < 0) {
            connection.close()
            return null
        }
        return ConnectionFd(connection)
    }

    override fun setListener(listener: UvcUsbGateway.Listener?) {
        this.listener = listener
        if (listener != null && !closed) ensureRegistered()
    }

    override fun close() {
        synchronized(registerLock) {
            if (closed) return
            closed = true
            listener = null
            if (registered) {
                try {
                    appContext.unregisterReceiver(receiver)
                } catch (t: Throwable) {
                    Log.w(TAG, "unregisterReceiver: ${t.message}")
                }
                registered = false
                Log.i(TAG, "UVC USB receiver unregistered")
            }
        }
    }

    private fun ensureRegistered() {
        synchronized(registerLock) {
            if (closed || registered) return
            val filter = IntentFilter().apply {
                addAction(ACTION_USB_PERMISSION)
                addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            }
            if (Build.VERSION.SDK_INT >= 33) {
                appContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                appContext.registerReceiver(receiver, filter)
            }
            registered = true
            Log.i(TAG, "UVC USB receiver registered")
        }
    }

    private class ConnectionFd(private val connection: UsbDeviceConnection) : AuthorizedCameraFd {
        @Volatile
        private var closed = false

        override fun fileDescriptor(): Int = connection.fileDescriptor

        override fun close() {
            if (closed) return
            closed = true
            connection.close()
        }
    }

    companion object {
        private const val TAG = "FitbausUvcUsb"
        private const val ACTION_USB_PERMISSION = "com.fitbaus.bikebridge.UVC_USB_PERMISSION"
        internal const val EXTRA_REQUEST_ID = "com.fitbaus.bikebridge.UVC_REQUEST_ID"
        internal const val NO_REQUEST_ID = -1L

        private fun UsbDevice.toInfo(): UvcDeviceInfo {
            var vc = false
            var vs = false
            for (i in 0 until interfaceCount) {
                val iface = getInterface(i)
                if (iface.interfaceClass == UsbConstants.USB_CLASS_VIDEO) {
                    when (iface.interfaceSubclass) {
                        1 -> vc = true
                        2 -> vs = true
                    }
                }
            }
            val serial = try {
                serialNumber
            } catch (_: SecurityException) {
                null
            }
            return UvcDeviceInfo(
                deviceName = deviceName,
                vendorId = vendorId,
                productId = productId,
                serial = serial,
                hasVideoControl = vc,
                hasVideoStreaming = vs,
            )
        }
    }
}
