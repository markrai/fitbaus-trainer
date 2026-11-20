// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.controller

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper

internal class AutoControllerOwnership(
    private val context: Context,
    private val hid: ExclusiveHid,
    private val manager: UsbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val attemptedClaims = mutableSetOf<String>()
    private var pendingDevice: String? = null
    private var running = false
    private var statusText = "No USB gamepad connected"

    private val poll = object : Runnable {
        override fun run() {
            if (!running) return
            reconcile()
            handler.postDelayed(this, 1_500L)
        }
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_USB_PERMISSION -> {
                    @Suppress("DEPRECATION")
                    val device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE) as UsbDevice? ?: return
                    if (device.deviceName != pendingDevice) return
                    pendingDevice = null
                    if (!running) return
                    if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) &&
                        manager.hasPermission(device)
                    ) {
                        deniedDevices.remove(device.deviceName)
                        attemptedClaims.remove(device.deviceName)
                        reconcile()
                    } else {
                        deniedDevices.add(device.deviceName)
                        statusText = "USB permission denied; Android controller events remain intercepted"
                    }
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    @Suppress("DEPRECATION")
                    val device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE) as UsbDevice? ?: return
                    deniedDevices.remove(device.deviceName)
                    attemptedClaims.remove(device.deviceName)
                    if (pendingDevice == device.deviceName) pendingDevice = null
                    if (hid.activeCandidate()?.deviceName == device.deviceName) hid.stop()
                    if (running) reconcile()
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> if (running) reconcile()
            }
        }
    }

    fun onHostResume() {
        if (running) return
        running = true
        val filter = IntentFilter(ACTION_USB_PERMISSION).apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(receiver, filter)
        }
        handler.removeCallbacks(poll)
        handler.post(poll)
    }

    fun onHostPause() {
        if (!running) return
        running = false
        handler.removeCallbacks(poll)
        context.unregisterReceiver(receiver)
        pendingDevice = null
        attemptedClaims.clear()
        hid.stop()
    }

    fun status(): String = if (hid.isActive()) hid.status() else statusText

    private fun reconcile() {
        if (!running) return
        val names = manager.deviceList.keys
        deniedDevices.retainAll(names)
        attemptedClaims.retainAll(names)
        val active = hid.activeCandidate()
        if (active != null) {
            if (active.deviceName !in names) hid.stop() else return
        }
        val candidate = hid.selected()
        if (candidate == null) {
            statusText = "No unambiguous eligible USB HID gamepad; Android input still intercepted"
            return
        }
        val name = candidate.deviceName
        val device = manager.deviceList[name] ?: return
        if (manager.hasPermission(device)) {
            if (!attemptedClaims.add(name)) return
            if (!hid.start()) statusText = hid.status()
            return
        }
        if (name == pendingDevice) return
        if (name in deniedDevices) {
            statusText = "USB permission denied for connected gamepad; Android input still intercepted"
            return
        }
        pendingDevice = name
        val permissionIntent = Intent(ACTION_USB_PERMISSION).setPackage(context.packageName)
        val flags = if (Build.VERSION.SDK_INT >= 31) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        } else PendingIntent.FLAG_UPDATE_CURRENT
        val pending = PendingIntent.getBroadcast(context, REQUEST_CODE, permissionIntent, flags)
        try {
            manager.requestPermission(device, pending)
            statusText = "Waiting for Android USB gamepad permission"
        } catch (_: Exception) {
            pendingDevice = null
            deniedDevices.add(name)
            statusText = "USB permission request unavailable; Android input still intercepted"
        }
    }

    companion object {
        private const val ACTION_USB_PERMISSION = "com.fitbaus.bikebridge.AUTO_HID_PERMISSION"
        private const val REQUEST_CODE = 7164
        private val deniedDevices = mutableSetOf<String>()
    }
}
