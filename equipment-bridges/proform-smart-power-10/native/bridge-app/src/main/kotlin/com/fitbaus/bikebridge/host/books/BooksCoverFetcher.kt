// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI

internal class BooksCoverFetcher(private val connection: BooksConnection) {
    fun fetch(itemId: String): Bitmap? {
        if (Thread.currentThread().isInterrupted) return null
        return try {
            val request = URI(connection.server.coverUrl(itemId)).toURL().openConnection() as HttpURLConnection
            try {
                request.instanceFollowRedirects = false
                request.connectTimeout = 8_000
                request.readTimeout = 10_000
                request.setRequestProperty("Authorization", "Bearer " + connection.token)
                if (request.responseCode != 200) return null
                val bytes = request.inputStream.use { input ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        if (Thread.currentThread().isInterrupted) return null
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (output.size() + count > 1024 * 1024) return null
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                if (bounds.outWidth !in 1..16384 || bounds.outHeight !in 1..16384) return null
                var sample = 1
                while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 512) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
                    inSampleSize = sample
                    inPreferredConfig = Bitmap.Config.RGB_565
                })
            } finally {
                request.disconnect()
            }
        } catch (_: Exception) {
            null
        }
    }
}
