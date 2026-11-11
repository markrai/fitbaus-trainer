// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.fitbaus.bikebridge.host.usb.AndroidUsbHostGateway
import com.fitbaus.bikebridge.protocol.BridgeHttpJson
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class NativeBridgeService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var http: NativeHttpServer? = null
    private var usb: NativeUsbSession? = null
    private var receiverRegistered = false
    private val permissionLatch = AtomicReference<CountDownLatch?>(null)
    private val permissionGranted = AtomicBoolean(false)
    private lateinit var permissionAction: String

    @Volatile
    private var httpError: String? = null

    private val bindRetry = Runnable { startHttpAndUsb() }

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != permissionAction) return
            permissionGranted.set(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
            permissionLatch.get()?.countDown()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        permissionAction = packageName + HostConstants.USB_PERMISSION_SUFFIX
        startForegroundCompat()
        val filter = IntentFilter(permissionAction)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(usbReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(usbReceiver, filter)
        }
        receiverRegistered = true
        val usbManager = getSystemService(USB_SERVICE) as UsbManager
        val gateway = AndroidUsbHostGateway(usbManager)
        val heartRate = BridgeProcess.heartRate()
        val brightness = BridgeProcess.brightness(this)
        val pairing = BridgeProcess.pairing(this)
        val session = NativeUsbSession(
            gateway = gateway,
            requestPermission = { deviceName -> requestUsbPermission(usbManager, deviceName) },
            coldStartWritePlan = UnlockQualification.plan(),
        )
        usb = session
        http = NativeHttpServer(
            snapshot = { session.snapshot() },
            onHeartRate = { bpm -> heartRate.record(bpm) },
            onBrightness = { percent -> brightness.record(percent) },
            onResistance = { level -> session.setResistance(level) },
            pairingToken = { pairing.token() },
        )
        startHttpAndUsb()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == HostConstants.ACTION_USB_RECHECK) {
            usb?.requestPermissionAgain()
        }
        if (http?.isListening() == true) {
            usb?.ensureRunning()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(bindRetry)
        val stop = usb?.stop()
        if (stop == SessionStopResult.TimedOut) {
            Log.e(
                HostConstants.LOG_TAG,
                "native USB stop timed out; Legacy recovery must not assume USB was released",
            )
        }
        usb = null
        http?.stop()
        if (receiverRegistered) {
            unregisterReceiver(usbReceiver)
            receiverRegistered = false
        }
        if (instance === this) instance = null
        super.onDestroy()
    }

    internal fun session(): NativeUsbSession? = usb

    internal fun httpError(): String? = httpError

    internal fun isHttpListening(): Boolean = http?.isListening() == true

    private fun startHttpAndUsb() {
        val server = http ?: return
        val session = usb ?: return
        if (startHttpThenUsb(server, session)) {
            httpError = null
            return
        }
        val reason = server.lastError() ?: "bind failed"
        httpError = reason
        Log.e(
            HostConstants.LOG_TAG,
            "HTTP bind failed on ${BridgeHttpJson.DEFAULT_BIND}:${BridgeHttpJson.DEFAULT_PORT} ($reason); USB not opened; retrying",
        )
        handler.removeCallbacks(bindRetry)
        handler.postDelayed(bindRetry, HostConstants.HTTP_BIND_RETRY_MS)
    }

    private fun requestUsbPermission(usbManager: UsbManager, deviceName: String): Boolean {
        val device: UsbDevice = usbManager.deviceList.values.firstOrNull { it.deviceName == deviceName }
            ?: return false
        if (usbManager.hasPermission(device)) return true
        if (bootGracePending.getAndSet(false) && awaitGrantedByAttach(usbManager, device)) return true
        val latch = CountDownLatch(1)
        permissionLatch.set(latch)
        permissionGranted.set(false)
        val intent = PendingIntent.getBroadcast(
            this,
            0,
            Intent(permissionAction).setPackage(packageName),
            usbPermissionPendingIntentFlags(),
        )
        usbManager.requestPermission(device, intent)
        return try {
            latch.await(HostConstants.USB_PERMISSION_TIMEOUT_S, TimeUnit.SECONDS) && permissionGranted.get()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
    }

    private fun awaitGrantedByAttach(usbManager: UsbManager, device: UsbDevice): Boolean {
        val deadline = System.currentTimeMillis() + HostConstants.BOOT_PERMISSION_GRACE_MS
        while (System.currentTimeMillis() < deadline) {
            if (usbManager.hasPermission(device)) return true
            try {
                Thread.sleep(250)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return false
            }
        }
        return usbManager.hasPermission(device)
    }

    private fun usbPermissionPendingIntentFlags(): Int =
        if (Build.VERSION.SDK_INT >= 31) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }

    private fun startForegroundCompat() {
        val launch = PendingIntent.getActivity(
            this,
            0,
            Intent(this, NativeBridgeActivity::class.java),
            if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.app_name), NotificationManager.IMPORTANCE_MIN),
            )
            Notification.Builder(this, CHANNEL_ID)
        } else {
            legacyNotificationBuilder()
        }
        val notification = builder
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.service_running))
            .setOngoing(true)
            .setContentIntent(launch)
            .build()
        startForeground(HostConstants.NOTIFICATION_ID, notification)
    }

    @Suppress("DEPRECATION")
    private fun legacyNotificationBuilder(): Notification.Builder = Notification.Builder(this)

    companion object {
        private const val CHANNEL_ID = "bike_bridge"

        private val bootGracePending = AtomicBoolean(false)

        internal fun markBootStart() {
            bootGracePending.set(true)
        }

        @Volatile
        var instance: NativeBridgeService? = null
            private set
    }
}

internal fun startHttpThenUsb(server: NativeHttpServer, session: NativeUsbSession): Boolean {
    try {
        server.start()
    } catch (_: Exception) {
        return false
    }
    session.start()
    return true
}
