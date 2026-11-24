// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.ImageView
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

internal class ThumbnailLoader(
    private val targetWidth: Int,
    maxCacheBytes: Int = MAX_CACHE_BYTES,
    private val fetchBitmap: ((String) -> Bitmap?)? = null,
) {
    private val main = Handler(Looper.getMainLooper())
    private val executor = Executors.newFixedThreadPool(THREADS) { runnable ->
        Thread(runnable, "fitbaus-yt-thumbs").apply {
            isDaemon = true
            priority = Thread.MIN_PRIORITY
        }
    }
    private val cache = object : LruCache<String, Bitmap>(maxCacheBytes) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val requests = ThumbnailRequests<ImageView>()
    private var closed = false

    fun bind(view: ImageView, url: String) {
        if (view.tag == url) return
        requests.cancel(view)
        view.tag = url
        val cached = cache.get(url)
        if (cached != null) {
            view.setImageBitmap(cached)
            return
        }
        view.setImageDrawable(null)
        if (closed) {
            view.tag = null
            return
        }
        val ticket = requests.begin(view, url)
        val future = try {
            executor.submit {
                val bitmap = if (fetchBitmap == null) fetch(url) else fetchBitmap.invoke(url)
                main.post { complete(view, ticket, bitmap) }
            }
        } catch (_: RejectedExecutionException) {
            requests.finish(view, ticket)
            view.tag = null
            return
        }
        ticket.onCancel = { future.cancel(true) }
    }

    fun clear(view: ImageView) {
        requests.cancel(view)
        view.tag = null
        view.setImageDrawable(null)
    }

    fun pause() {
        for (view in requests.cancelAll()) view.tag = null
        cache.evictAll()
    }

    fun shutdown() {
        closed = true
        pause()
        executor.shutdownNow()
    }

    private fun complete(view: ImageView, ticket: ThumbnailRequests.Ticket, bitmap: Bitmap?) {
        if (!requests.finish(view, ticket)) return
        if (bitmap != null && !closed) {
            cache.put(ticket.key, bitmap)
            view.setImageBitmap(bitmap)
        } else {
            view.tag = null
        }
    }

    val cachedBytes: Int
        get() = cache.size()

    private fun fetch(url: String): Bitmap? {
        if (Thread.currentThread().isInterrupted) return null
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = 8_000
            connection.readTimeout = 10_000
            connection.setRequestProperty("User-Agent", HttpUrlDownloader.USER_AGENT)
            if (connection.responseCode != 200) return null
            val bytes = connection.inputStream.use { input ->
                val out = ByteArrayOutputStream(32 * 1024)
                val buffer = ByteArray(16 * 1024)
                var total = 0
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > MAX_IMAGE_BYTES) return null
                    out.write(buffer, 0, read)
                }
                out.toByteArray()
            }
            decode(bytes)
        } catch (_: Exception) {
            null
        } finally {
            connection.disconnect()
        }
    }

    private fun decode(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options()
        bounds.inJustDecodeBounds = true
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= targetWidth) sample *= 2
        val options = BitmapFactory.Options()
        options.inSampleSize = sample
        options.inPreferredConfig = Bitmap.Config.RGB_565
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    }

    companion object {
        const val MAX_CACHE_BYTES: Int = 4 * 1024 * 1024
        const val MAX_IMAGE_BYTES: Int = 512 * 1024
        private const val THREADS = 2
    }
}

internal class ThumbnailRequests<V : Any> {
    class Ticket(val key: String) {
        var onCancel: () -> Unit = {}
    }

    private val current = HashMap<V, Ticket>()

    val size: Int
        get() = current.size

    fun begin(view: V, key: String): Ticket {
        cancel(view)
        return Ticket(key).also { current[view] = it }
    }

    fun isCurrent(view: V, ticket: Ticket): Boolean = current[view] === ticket

    fun finish(view: V, ticket: Ticket): Boolean {
        if (current[view] !== ticket) return false
        current.remove(view)
        return true
    }

    fun cancel(view: V) {
        current.remove(view)?.onCancel?.invoke()
    }

    fun cancelAll(): List<V> {
        val views = current.keys.toList()
        val tickets = current.values.toList()
        current.clear()
        for (ticket in tickets) ticket.onCancel()
        return views
    }
}
