// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream

internal object YouTubeCredentialsImport {
    const val ACTION = "com.fitbaus.bikebridge.action.IMPORT_YOUTUBE_AUTH"
    const val EXTRA_NONCE = "com.fitbaus.bikebridge.extra.IMPORT_NONCE"
    private const val LIMIT = 16384
    private val noncePattern = Regex("[a-f0-9]{32}")

    fun validNonce(value: String?): Boolean = value != null && noncePattern.matches(value)

    fun loadAndDelete(context: Context, nonce: String): GoogleClient {
        require(validNonce(nonce))
        val file = File(directory(context), "$nonce.json")
        try {
            require(file.isFile && file.length() in 1L..LIMIT.toLong())
            val bytes = FileInputStream(file).use { stream ->
                val buffer = ByteArray(LIMIT + 1)
                var count = 0
                while (count < buffer.size) {
                    val read = stream.read(buffer, count, buffer.size - count)
                    if (read < 0) break
                    count += read
                }
                require(count in 1..LIMIT)
                buffer.copyOf(count)
            }
            return parse(String(bytes, Charsets.UTF_8))
        } finally {
            file.delete()
        }
    }

    fun parse(json: String): GoogleClient {
        require(json.length in 1..LIMIT)
        val installed = JSONObject(json).getJSONObject("installed")
        val id = installed.optString("client_id", "").trim()
        val secret = installed.optString("client_secret", "").trim()
        require(id.matches(Regex("[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com")) && id.length <= 256)
        require(secret.isNotEmpty() && secret.length <= 256)
        return GoogleClient(id, secret)
    }

    fun acknowledge(context: Context, nonce: String, succeeded: Boolean) {
        if (!validNonce(nonce)) return
        runCatching {
            val folder = directory(context)
            check(folder.isDirectory || folder.mkdirs())
            File(folder, "$nonce.status").writeText(if (succeeded) "OK" else "ERROR", Charsets.UTF_8)
        }
    }

    private fun directory(context: Context): File =
        File(context.getExternalFilesDir(null) ?: error("App external storage unavailable"), "youtube-auth-import")
}
