// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class GoogleDeviceHandoffUiTest {
    private val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/youtube/GoogleAccountView.kt")
        .readText()

    @Test
    fun theCodeIsDisplayedAsProvidedAndAManualFallbackRemains() {
        assertTrue(source.contains("verificationCode.text = status.userCode"))
        assertTrue(source.contains("verificationAddress.text = status.verificationUrl"))
        assertTrue(source.contains("verificationCode.setTextIsSelectable(true)"))
        assertTrue(source.contains("qrImage.contentDescription"))
        assertTrue(source.contains("QR unavailable. Open the URL above"))
    }

    @Test
    fun qrUsesTheServerSuppliedScanUrlAndDoesNotInventAQueryParameter() {
        assertTrue(source.contains("status.verificationScanUrl.ifEmpty { status.verificationUrl }"))
        assertTrue(source.contains("GoogleDeviceQr.bitmap(url)"))
        assertFalse(source.contains("user_code="))
        assertFalse(source.contains("qrcode.googleapis.com"))
    }

    @Test
    fun endingAuthorizationClearsTheRenderedQrAndCode() {
        assertTrue(source.contains("if (status.phase != GoogleAccountPhase.Authorizing)"))
        assertTrue(source.contains("clearQr()"))
        assertTrue(source.contains("qrImage.setImageDrawable(null)"))
        assertTrue(source.contains("verificationCode.text = \"\""))
        val closed = source.substringAfter("fun close() {").substringBefore("fun reset()")
        assertTrue(closed.contains("clearQr()"))
    }

    @Test
    fun authorizationStatusUsesExactOriginalUrlAndCode() {
        val status = GoogleAccountStatus(
            phase = GoogleAccountPhase.Authorizing,
            verificationUrl = "https://www.google.com/device",
            userCode = "aBcd-1XyZ",
            verificationScanUrl = "https://www.google.com/device",
        )
        assertEquals("aBcd-1XyZ", status.userCode)
        assertEquals(status.verificationUrl, status.verificationScanUrl)
    }
}
