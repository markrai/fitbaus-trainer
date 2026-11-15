// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import android.util.Log
import com.fitbaus.arcade.AuthorizedCameraFd
import com.fitbaus.arcade.ExternalCameraProvider
import java.util.concurrent.atomic.AtomicLong

/**
 * USB Host owner for external UVC webcams (VideoControl + VideoStreaming).
 *
 * [openAuthorizedCamera] never blocks waiting for a permission dialog.
 * Existing authorization opens immediately; first-time prompts are fired asynchronously and the
 * caller falls back to Camera1 until a later game enter after grant. Denial is sticky until detach.
 *
 * Map mutations are synchronized; USB Host calls run outside the lock.
 * [closed] is volatile so Activity destruction is visible across threads without holding the lock
 * during USB I/O.
 */
internal class UvcCameraHost(
    private val gateway: UvcUsbGateway,
    private val machine: UvcPermissionMachine = UvcPermissionMachine(),
) : ExternalCameraProvider, AutoCloseable {
    private val lock = Any()
    private val keysByDeviceName = HashMap<String, String>()
    /** Outstanding permission request; broadcasts must match name, key, and request id. */
    private var pendingRequest: PendingUsbRequest? = null

    @Volatile
    private var closed = false

    constructor(appContext: android.content.Context) : this(AndroidUvcUsbGateway(appContext))

    init {
        gateway.setListener(object : UvcUsbGateway.Listener {
            override fun onPermissionBroadcast(deviceName: String, extraGranted: Boolean, requestId: Long) {
                handlePermissionBroadcast(deviceName, extraGranted, requestId)
            }

            override fun onDeviceDetached(deviceName: String) {
                handleDetach(deviceName)
            }
        })
    }

    private val detachListeners = LinkedHashSet<DetachListener>()

    fun interface DetachListener {
        fun onUvcDetached(deviceName: String, deviceKey: String?)
    }

    fun listDevices(): Collection<UvcDeviceInfo> =
        if (closed) emptyList() else gateway.listDevices()

    fun hasPermission(deviceName: String): Boolean =
        !closed && gateway.hasPermission(deviceName)

    fun addDetachListener(listener: DetachListener) {
        synchronized(lock) {
            if (!closed) detachListeners.add(listener)
        }
    }

    fun removeDetachListener(listener: DetachListener) {
        synchronized(lock) {
            detachListeners.remove(listener)
        }
    }

    /**
     * Fires the existing USB permission state machine without opening a camera connection.
     * Safe to call from the UI thread; never blocks on USB control transfers for streaming.
     */
    fun promptUsbPermission(): Boolean {
        if (closed) return false
        val device = UvcProcess.resolveExternalCamera(gateway.listDevices()) ?: return false
        if (closed) return false
        if (gateway.hasPermission(device.deviceName)) return true
        val action = synchronized(lock) {
            if (closed) return false
            keysByDeviceName[device.deviceName] = device.key
            machine.onOpenAttempt(device.key, hasPermission = false)
        }
        return when (action) {
            UvcPermissionAction.RequestThenFallback -> dispatchPermissionRequest(device)
            UvcPermissionAction.OpenNow, UvcPermissionAction.FallbackNoPrompt -> false
        }
    }

    override fun openAuthorizedCamera(): AuthorizedCameraFd? {
        if (closed) return null
        val device = UvcProcess.resolveExternalCamera(gateway.listDevices()) ?: return null
        if (closed) return null
        val hasPerm = gateway.hasPermission(device.deviceName)
        val action = synchronized(lock) {
            if (closed) return null
            keysByDeviceName[device.deviceName] = device.key
            machine.onOpenAttempt(device.key, hasPerm)
        }
        return when (action) {
            UvcPermissionAction.OpenNow -> {
                if (closed) return null
                if (!gateway.hasPermission(device.deviceName)) {
                    synchronized(lock) {
                        if (!closed) machine.onPermissionResult(device.key, false)
                    }
                    null
                } else {
                    val fd = gateway.openDevice(device.deviceName)
                    if (closed) {
                        try {
                            fd?.close()
                        } catch (_: Throwable) {
                        }
                        null
                    } else {
                        fd?.let {
                            IdentifiedCameraFd(
                                it,
                                WebcamZoomStore.identityKey(device),
                                device.key,
                            )
                        }
                    }
                }
            }
            UvcPermissionAction.FallbackNoPrompt -> null
            UvcPermissionAction.RequestThenFallback -> {
                dispatchPermissionRequest(device)
                null
            }
        }
    }

    private fun dispatchPermissionRequest(device: UvcDeviceInfo): Boolean {
        val request = synchronized(lock) {
            if (closed) return false
            val id = processRequestSeq.getAndIncrement()
            PendingUsbRequest(device.deviceName, device.key, id).also { pendingRequest = it }
        }
        val dispatched = try {
            if (!closed) gateway.requestPermission(device.deviceName, request.requestId) else false
        } catch (t: Throwable) {
            Log.e(TAG, "requestPermission failed", t)
            false
        }
        synchronized(lock) {
            if (closed) {
                if (pendingRequest == request) pendingRequest = null
                return false
            }
            if (!dispatched) {
                if (pendingRequest == request) pendingRequest = null
                machine.onRequestFailed(device.key)
            }
        }
        return dispatched
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            pendingRequest = null
            keysByDeviceName.clear()
            detachListeners.clear()
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

    private fun handlePermissionBroadcast(deviceName: String, extraGranted: Boolean, requestId: Long) {
        if (closed) return
        val claimed = synchronized(lock) {
            if (closed) return
            val pending = pendingRequest
            if (pending == null ||
                pending.deviceName != deviceName ||
                pending.requestId != requestId
            ) {
                Log.i(
                    TAG,
                    "ignoring permission broadcast for $deviceName requestId=$requestId " +
                        "pendingName=${pending?.deviceName} pendingId=${pending?.requestId}",
                )
                return
            }
            pending
        }

        // USB lookups run outside the host lock.
        val device = gateway.listDevices().firstOrNull { it.deviceName == deviceName }
        if (device != null) {
            if (!UvcDeviceSelector.isExternalUvc(device)) return
            if (device.key != claimed.key) {
                Log.i(TAG, "ignoring stale broadcast key=${device.key} pendingKey=${claimed.key}")
                return
            }
        }
        if (closed) return
        val live = gateway.hasPermission(deviceName)

        // Revalidate after USB I/O so close/detach cannot be followed by a stale machine update.
        synchronized(lock) {
            if (closed) return
            val pending = pendingRequest
            if (pending == null ||
                pending.deviceName != deviceName ||
                pending.requestId != requestId ||
                pending.key != claimed.key
            ) {
                Log.i(
                    TAG,
                    "dropping stale permission result after close/detach device=$deviceName " +
                        "requestId=$requestId",
                )
                return
            }
            if (device != null) keysByDeviceName[deviceName] = device.key
            val phase = machine.onPermissionResult(pending.key, live)
            pendingRequest = null
            Log.i(
                TAG,
                "permission result device=$deviceName extraGranted=$extraGranted live=$live " +
                    "phase=$phase key=${pending.key} requestId=$requestId",
            )
        }
    }

    private fun handleDetach(deviceName: String) {
        if (closed) return
        val (key, listeners) = synchronized(lock) {
            if (closed) return
            val pending = pendingRequest
            if (pending != null && pending.deviceName == deviceName) pendingRequest = null
            val removed = keysByDeviceName.remove(deviceName)
            removed to detachListeners.toList()
        }
        if (key != null) {
            machine.onDetached(key)
        }
        Log.i(TAG, "uvc detached name=$deviceName key=$key")
        for (listener in listeners) {
            try {
                listener.onUvcDetached(deviceName, key)
            } catch (t: Throwable) {
                Log.e(TAG, "detach listener failed", t)
            }
        }
    }

    private data class PendingUsbRequest(
        val deviceName: String,
        val key: String,
        val requestId: Long,
    )

    /** Binds zoom preference identity and attachment key to the FD that was actually opened. */
    private class IdentifiedCameraFd(
        private val inner: AuthorizedCameraFd,
        private val identity: String,
        private val attachment: String,
    ) : AuthorizedCameraFd {
        override fun fileDescriptor(): Int = inner.fileDescriptor()
        override fun zoomIdentity(): String = identity
        override fun attachmentKey(): String = attachment
        override fun close() = inner.close()
    }

    companion object {
        private const val TAG = "FitbausUvcHost"

        /**
         * Process-wide sequence so a recreated Activity cannot reuse request ids still embedded in
         * an older outstanding USB permission PendingIntent.
         */
        private val processRequestSeq = AtomicLong(System.currentTimeMillis() shl 20)

        /** Test helper: peek the next id that would be allocated. */
        internal fun peekNextRequestIdForTest(): Long = processRequestSeq.get()
    }
}
