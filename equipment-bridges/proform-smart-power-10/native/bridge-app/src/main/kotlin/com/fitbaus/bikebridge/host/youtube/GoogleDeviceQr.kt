// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter

internal object GoogleDeviceQr {
    const val SIZE = 256

    fun matrix(url: String): BitMatrix {
        require(GoogleDeviceVerification.isTrusted(url))
        return QRCodeWriter().encode(url, BarcodeFormat.QR_CODE, SIZE, SIZE)
    }

    fun bitmap(url: String): Bitmap {
        val bits = matrix(url)
        val pixels = IntArray(SIZE * SIZE) { index ->
            if (bits[index % SIZE, index / SIZE]) Color.BLACK else Color.WHITE
        }
        return Bitmap.createBitmap(pixels, SIZE, SIZE, Bitmap.Config.RGB_565)
    }
}
