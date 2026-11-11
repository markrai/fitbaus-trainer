// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.content.Context
import android.content.SharedPreferences

internal object BridgeProcess {
    private var heartRate: HeartRateStore? = null
    private var brightness: BrightnessStore? = null
    private var pairing: PairingTokenStore? = null

    @Synchronized
    fun heartRate(): HeartRateStore =
        heartRate ?: HeartRateStore().also { heartRate = it }

    @Synchronized
    fun brightness(context: Context): BrightnessStore =
        brightness ?: BrightnessStore(
            SharedPreferencesIntPersistence(prefs(context, HostConstants.BRIGHTNESS_PREFS), HostConstants.BRIGHTNESS_KEY),
        ).also { brightness = it }

    @Synchronized
    fun pairing(context: Context): PairingTokenStore =
        pairing ?: PairingTokenStore(
            SharedPreferencesStringPersistence(prefs(context, HostConstants.PAIRING_PREFS), HostConstants.PAIRING_KEY),
        ).also { pairing = it }

    private fun prefs(context: Context, name: String): SharedPreferences =
        context.applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE)
}

internal class SharedPreferencesIntPersistence(
    private val prefs: SharedPreferences,
    private val key: String,
) : IntPersistence {
    override fun load(): Int? = if (prefs.contains(key)) prefs.getInt(key, Int.MIN_VALUE) else null

    override fun save(value: Int) {
        prefs.edit().putInt(key, value).apply()
    }
}

internal class SharedPreferencesStringPersistence(
    private val prefs: SharedPreferences,
    private val key: String,
) : StringPersistence {
    override fun load(): String? = prefs.getString(key, null)

    override fun save(value: String) {
        prefs.edit().putString(key, value).apply()
    }
}
