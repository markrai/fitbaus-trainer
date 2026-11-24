// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
import java.io.File
import java.io.IOException
import java.security.MessageDigest

internal data class BooksTranscriptRequest(val serverAddress: String, val itemId: String) {
    init {
        BooksServer(serverAddress)
        require(itemId.matches(Regex("[A-Za-z0-9_-]{1,128}")))
    }

    fun relativePath(): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(serverAddress.toByteArray(Charsets.UTF_8))
        val key = digest.joinToString("") { "%02x".format(it.toInt() and 255) }
        return "read-along/$key/$itemId"
    }
}

internal data class BooksTranscriptLoad(val transcript: BooksTranscript?, val localPath: String?)

internal fun interface BooksTranscriptSource {
    fun load(request: BooksTranscriptRequest): BooksTranscriptLoad
}

internal class LocalBooksTranscriptSource(context: Context) : BooksTranscriptSource {
    private val app = context.applicationContext

    override fun load(request: BooksTranscriptRequest): BooksTranscriptLoad {
        val root = app.getExternalFilesDir(null) ?: throw IOException("Local transcript storage unavailable")
        val base = File(root, request.relativePath())
        val vtt = File(base.path + ".vtt")
        val srt = File(base.path + ".srt")
        val parent = vtt.parentFile ?: throw IOException("Invalid transcript directory")
        if (!parent.isDirectory && !parent.mkdirs() && !parent.isDirectory) {
            throw IOException("Could not create transcript directory")
        }
        val source = when {
            vtt.isFile -> vtt
            srt.isFile -> srt
            else -> return BooksTranscriptLoad(null, vtt.absolutePath)
        }
        if (!source.canonicalFile.path.startsWith(root.canonicalPath + File.separator)) {
            throw IOException("Invalid transcript path")
        }
        return BooksTranscriptLoad(source.inputStream().use(BooksTranscriptParser::read), source.absolutePath)
    }
}
