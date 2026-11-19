// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import java.net.URI

internal object GoogleDeviceVerification {
    private const val VERIFICATION_URL = "https://www.google.com/device"
    private const val MAX_COMPLETE_LENGTH = 512

    fun isTrusted(url: String): Boolean {
        val uri = runCatching { URI(url) }.getOrNull() ?: return false
        return uri.scheme == "https" && uri.host == "www.google.com" &&
            uri.port == -1 && uri.rawUserInfo == null && uri.rawFragment == null &&
            (uri.rawPath == "/device" || uri.rawPath == "/device/") &&
            url.length <= MAX_COMPLETE_LENGTH
    }

    fun scanUrl(verificationUrl: String, completeUrl: String?): String {
        require(verificationUrl == VERIFICATION_URL || verificationUrl == VERIFICATION_URL + "/")
        if (completeUrl.isNullOrBlank() || !isTrusted(completeUrl)) return verificationUrl
        val uri = URI(completeUrl)
        if (uri.rawQuery.isNullOrBlank()) return verificationUrl
        return completeUrl
    }
}
