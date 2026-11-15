// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.uvc

import android.content.Context
import android.content.SharedPreferences
import com.fitbaus.arcade.UvcZoomPreference

/**
 * Persists absolute-zoom preferences keyed by a stable camera identity.
 * Prefers VID:PID:serial when serial is known; otherwise VID:PID only.
 *
 * Absence of a stored value, and a malformed stored value, both mean "untouched": callers must not
 * treat either as an automatic "Widest" (or any other) zoom command.
 *
 * Limitation: two simultaneously connected cameras that share VID/PID and lack readable serials
 * cannot be distinguished; they share one preference key.
 */
internal object WebcamZoomStore {
    private const val PREFS = "external_webcam_zoom"
    private const val MODE_WIDEST = "widest"
    private const val MODE_DEFAULT = "default"
    private const val MODE_ABS = "abs:"

    fun identityKey(device: UvcDeviceInfo): String {
        val serial = device.serial?.trim().orEmpty()
        return if (serial.isNotEmpty()) {
            String.format("%04x:%04x:%s", device.vendorId and 0xffff, device.productId and 0xffff, serial)
        } else {
            String.format("%04x:%04x", device.vendorId and 0xffff, device.productId and 0xffff)
        }
    }

    fun loadOrNull(context: Context, identityKey: String): UvcZoomPreference? {
        val raw = prefs(context).getString(identityKey, null) ?: return null
        return decode(raw)
    }

    fun loadOrNull(context: Context, device: UvcDeviceInfo): UvcZoomPreference? =
        loadOrNull(context, identityKey(device))

    fun save(context: Context, identityKey: String, preference: UvcZoomPreference) {
        prefs(context).edit().putString(identityKey, encode(preference)).apply()
    }

    fun save(context: Context, device: UvcDeviceInfo, preference: UvcZoomPreference) {
        save(context, identityKey(device), preference)
    }

    fun encode(preference: UvcZoomPreference): String = when (preference) {
        UvcZoomPreference.Widest -> MODE_WIDEST
        UvcZoomPreference.CameraDefault -> MODE_DEFAULT
        is UvcZoomPreference.Absolute -> MODE_ABS + preference.value
    }

    /** Returns null when [raw] is empty or not a known encoding (malformed prefs are ignored). */
    fun decode(raw: String): UvcZoomPreference? {
        val trimmed = raw.trim()
        return when {
            trimmed.isEmpty() -> null
            trimmed == MODE_WIDEST -> UvcZoomPreference.Widest
            trimmed == MODE_DEFAULT -> UvcZoomPreference.CameraDefault
            trimmed.startsWith(MODE_ABS) -> {
                val value = trimmed.removePrefix(MODE_ABS).toIntOrNull() ?: return null
                UvcZoomPreference.Absolute(value)
            }
            else -> null
        }
    }

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
