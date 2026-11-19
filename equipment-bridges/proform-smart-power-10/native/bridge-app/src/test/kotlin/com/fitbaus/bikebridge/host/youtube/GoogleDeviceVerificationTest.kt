// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GoogleDeviceVerificationTest {
    private val url = "https://www.google.com/device"

    @Test
    fun ordinaryGoogleResponseKeepsExactUrlWithoutInventingCodeQuery() {
        assertEquals(url, GoogleDeviceVerification.scanUrl(url, null))
        assertEquals(url, GoogleDeviceVerification.scanUrl(url, ""))
        assertEquals(url, GoogleDeviceVerification.scanUrl(url, url))
        assertFalse(GoogleDeviceVerification.scanUrl(url, null).contains("user_code"))
    }

    @Test
    fun serverSuppliedCompleteUriCanBeEncodedWithoutModification() {
        val complete = "https://www.google.com/device?user_code=ABCD-EFGH"
        assertEquals(complete, GoogleDeviceVerification.scanUrl(url, complete))
        assertEquals(complete, decodeQr(GoogleDeviceQr.matrix(complete)))
    }

    @Test
    fun qrPointsToTheExactGoogleUrlAndContainsNoDeviceSecretOrUserCode() {
        val qr = GoogleDeviceQr.matrix(url)
        assertEquals(GoogleDeviceQr.SIZE, qr.width)
        assertEquals(GoogleDeviceQr.SIZE, qr.height)
        assertFalse(qr[0, 0])
        assertEquals(url, decodeQr(qr))
    }

    @Test
    fun rejectsOffDomainInsecureAndMalformedCompleteUrls() {
        val invalid = listOf(
            "http://www.google.com/device?user_code=ABCD",
            "https://www.google.com.evil.invalid/device?user_code=ABCD",
            "https://www.google.com@evil.invalid/device?user_code=ABCD",
            "https://www.google.com/redirect?user_code=ABCD",
            "https://www.google.com:444/device?user_code=ABCD",
            "https://www.google.com/device#fragment",
            "https://www.google.com/device?user_code=ABCD#fragment",
            "https://www.google.com/device?",
            "https://www.google.com/device",
            "data:text/html,forbidden",
        )
        invalid.forEach {
            assertEquals(url, GoogleDeviceVerification.scanUrl(url, it), it)
        }
        assertThrows(IllegalArgumentException::class.java) {
            GoogleDeviceVerification.scanUrl("https://bad.invalid/device", null)
        }
        assertThrows(IllegalArgumentException::class.java) {
            GoogleDeviceQr.matrix("https://bad.invalid/device")
        }
    }

    @Test
    fun qrRemainsReadableWithGoogleSuppliedLongCompleteUri() {
        val complete = "https://www.google.com/device?user_code=" + "A1B2C3D4" + "&state=" + "x".repeat(120)
        assertEquals(complete, decodeQr(GoogleDeviceQr.matrix(complete)))
        assertTrue(GoogleDeviceVerification.isTrusted(complete))
    }

    private fun decodeQr(matrix: com.google.zxing.common.BitMatrix): String {
        val pixels = IntArray(matrix.width * matrix.height) { index ->
            if (matrix[index % matrix.width, index / matrix.width]) -0x1000000 else -1
        }
        val source = RGBLuminanceSource(matrix.width, matrix.height, pixels)
        return QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source))).text
    }
}
