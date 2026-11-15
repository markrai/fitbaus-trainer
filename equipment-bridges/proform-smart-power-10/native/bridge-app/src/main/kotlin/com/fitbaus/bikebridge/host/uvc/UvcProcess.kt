// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import android.content.Context
import android.util.Log
import com.fitbaus.arcade.UvcZoomControls
import com.fitbaus.arcade.UvcZoomHook

/**
 * Process-scoped [UvcCameraHost] shared by the bridge Activity and settings Activity.
 *
 * Lifetime invariants (API 22, no Application-lifecycle framework):
 * - Exactly one host (one USB permission receiver) exists while any owner holds a token.
 * - [acquire] / [release] are token-based. Closing happens only when the last owner releases.
 * - [NativeBridgeActivity] and [PairingActivity] each acquire while alive and release on destroy.
 * - Destroying one Activity never invalidates the other's active preview/arcade stream via host close.
 * - Host close tears down USB receivers only after owners release; streaming cleanup (native then FD)
 *   remains the responsibility of the camera worker / preview session that opened the device.
 * - Do not call [closeForTests] outside unit tests.
 *
 * Zoom identity: [applySavedZoom] uses the identity captured on the opened FD, never a later
 * global selection that may refer to a different camera.
 *
 * Untouched cameras: when no preference is stored, no zoom command is issued (hardware default).
 * Saving [com.fitbaus.arcade.UvcZoomPreference.Widest] is an explicit user action.
 */
internal object UvcProcess {
    private const val TAG = "FitbausUvcProcess"

    private val lock = Any()
    private var host: UvcCameraHost? = null
    private val owners = HashSet<Any>()

    fun acquire(owner: Any, context: Context): UvcCameraHost = synchronized(lock) {
        owners.add(owner)
        host?.let { return it }
        return UvcCameraHost(context.applicationContext).also { host = it }
    }

    fun release(owner: Any) {
        synchronized(lock) {
            owners.remove(owner)
            if (owners.isNotEmpty()) return
            try {
                host?.close()
            } finally {
                host = null
            }
        }
    }

    /** Test-only: force teardown regardless of owners. */
    internal fun closeForTests() {
        synchronized(lock) {
            owners.clear()
            try {
                host?.close()
            } finally {
                host = null
            }
        }
    }

    /** Test-only: install a fake host without Android USB services. */
    internal fun installHostForTests(testHost: UvcCameraHost) {
        synchronized(lock) {
            try {
                host?.close()
            } catch (_: Throwable) {
            }
            host = testHost
            owners.clear()
        }
    }

    internal fun addOwnerForTests(owner: Any) {
        synchronized(lock) { owners.add(owner) }
    }

    internal fun ownerCountForTests(): Int = synchronized(lock) { owners.size }

    fun hostOrNull(): UvcCameraHost? = synchronized(lock) { host }

    /**
     * Authoritative external-webcam selection used by settings UI and [UvcCameraHost.openAuthorizedCamera].
     * Deterministic: first standards-compliant UVC device by lexicographic [UvcDeviceInfo.deviceName].
     */
    fun resolveExternalCamera(devices: Collection<UvcDeviceInfo>): UvcDeviceInfo? =
        UvcDeviceSelector.select(devices)

    /** Same as [resolveExternalCamera] against the live host enumeration. */
    fun selectedDevice(context: Context): UvcDeviceInfo? {
        val liveHost = synchronized(lock) { host } ?: return null
        return resolveExternalCamera(liveHost.listDevices())
    }

    /**
     * True when a USB detach event refers to the webcam the preview actually opened.
     * Unrelated UVC removals must not stop an active stream.
     */
    fun detachAffectsOpened(
        openedAttachmentKey: String?,
        detachedName: String,
        detachedKey: String?,
    ): Boolean {
        if (openedAttachmentKey.isNullOrEmpty()) return false
        if (detachedKey != null) return detachedKey == openedAttachmentKey
        return openedAttachmentKey.endsWith(":$detachedName")
    }

    fun zoomHook(context: Context): UvcZoomHook = UvcZoomHook { handle, zoomIdentity ->
        applySavedZoom(context, handle, zoomIdentity)
    }

    /**
     * Applies a previously saved preference for [zoomIdentity].
     * No-op when unset (hardware default preserved) or when zoom is unsupported / set fails.
     */
    fun applySavedZoom(context: Context, handle: Long, zoomIdentity: String?): Boolean {
        if (handle == 0L || zoomIdentity.isNullOrBlank()) return false
        val preference = WebcamZoomStore.loadOrNull(context, zoomIdentity) ?: return false
        val caps = UvcZoomControls.capability(handle)
        if (!caps.supported) return false
        val value = preference.resolve(caps) ?: return false
        val ok = UvcZoomControls.setAbsolute(handle, value)
        if (!ok) Log.w(TAG, "setZoomAbs failed for $zoomIdentity value=$value")
        return ok
    }
}
