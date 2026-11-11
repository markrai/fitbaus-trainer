// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

internal object HostConstants {
    const val LOG_TAG: String = "FITBAUS_NATIVE_BRIDGE"
    const val USB_PERMISSION_SUFFIX: String = ".USB_PERMISSION"
    const val OUT_TIMEOUT_MS: Int = 200
    const val IN_TIMEOUT_MS: Int = 1000
    const val MIN_REQUEST_SPACING_MS: Long = 100L
    const val STOP_JOIN_MS: Long = 8_000L
    const val RESISTANCE_QUEUE_WAIT_MS: Long = 2_000L
    const val RESISTANCE_TRANSMIT_WAIT_MS: Long = 1_500L
    const val MAX_CONSECUTIVE_EXCHANGE_FAILURES: Int = 10
    const val PERMISSION_POLL_MS: Long = 1_000L
    const val BOOT_PERMISSION_GRACE_MS: Long = 10_000L
    const val HTTP_BIND_RETRY_MS: Long = 5_000L
    const val USB_PERMISSION_TIMEOUT_S: Long = 60L
    const val INIT_MODE: String = "warm-state"
    const val UNLIMITED_USB_RECONNECT: Int = -1
    const val NOTIFICATION_ID: Int = 8765
    const val ACTION_USB_RECHECK: String = "com.fitbaus.bikebridge.action.USB_RECHECK"
    const val BRIGHTNESS_PREFS: String = "fitbaus_bike_bridge_brightness"
    const val BRIGHTNESS_KEY: String = "percent"
    const val PAIRING_PREFS: String = "fitbaus_bike_bridge_pairing"
    const val PAIRING_KEY: String = "token"
}
