// SPDX-License-Identifier: AGPL-3.0-only

@file:Suppress("DEPRECATION")

package com.fitbaus.bikebridge.host.books

import android.net.Uri
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.upstream.BaseDataSource
import com.google.android.exoplayer2.upstream.DataSpec
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection

internal class BooksAudioDataSource(
    private val session: BooksSession,
    private val allowedUrls: Set<String>,
) : BaseDataSource(true) {
    private var request: HttpURLConnection? = null
    private var stream: InputStream? = null
    private var openedUri: Uri? = null
    private var started = false
    private var remaining = C.LENGTH_UNSET.toLong()

    override fun open(dataSpec: DataSpec): Long {
        val url = dataSpec.uri.toString()
        require(url in allowedUrls && dataSpec.httpMethod == DataSpec.HTTP_METHOD_GET)
        transferInitializing(dataSpec)
        try {
            val connection = session.authorized { token ->
                val candidate = BooksServer.openConnection(url)
                try {
                    candidate.connectTimeout = 10_000
                    candidate.readTimeout = 15_000
                    candidate.setRequestProperty("Authorization", "Bearer $token")
                    candidate.setRequestProperty("Accept-Encoding", "identity")
                    if (dataSpec.position > 0 || dataSpec.length != C.LENGTH_UNSET.toLong()) {
                        val end = if (dataSpec.length == C.LENGTH_UNSET.toLong()) "" else
                            (dataSpec.position + dataSpec.length - 1).toString()
                        candidate.setRequestProperty("Range", "bytes=${dataSpec.position}-$end")
                    }
                    val status = candidate.responseCode
                    if (status == 401) throw BooksHttpFailure(status)
                    if (status != 200 && status != 206) throw IOException("Audio HTTP $status")
                    if (status == 206) {
                        val range = candidate.getHeaderField("Content-Range").orEmpty()
                        val start = range.substringAfter("bytes ", "").substringBefore('-').toLongOrNull()
                        if (start != dataSpec.position) throw IOException("Invalid audio range")
                    } else if (dataSpec.position != 0L) {
                        throw IOException("Server does not support audio range requests")
                    }
                    candidate
                } catch (error: Exception) {
                    candidate.disconnect()
                    throw error
                }
            }
            request = connection
            val available = connection.getHeaderField("Content-Length")?.toLongOrNull()?.takeIf { it >= 0 }
                ?: C.LENGTH_UNSET.toLong()
            remaining = if (dataSpec.length != C.LENGTH_UNSET.toLong()) {
                if (available >= 0) minOf(available, dataSpec.length) else dataSpec.length
            } else available
            stream = connection.inputStream
            openedUri = dataSpec.uri
            started = true
            transferStarted(dataSpec)
            return remaining
        } catch (error: Exception) {
            close()
            if (error is IOException) throw error
            throw IOException("Could not open audiobook audio", error)
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (remaining == 0L) return C.RESULT_END_OF_INPUT
        val limit = if (remaining < 0) length else minOf(remaining, length.toLong()).toInt()
        val count = stream?.read(buffer, offset, limit) ?: throw IOException("Audio not open")
        if (count < 0) {
            if (remaining > 0) throw EOFException("Incomplete audiobook response")
            return C.RESULT_END_OF_INPUT
        }
        if (remaining >= 0) remaining -= count
        bytesTransferred(count)
        return count
    }

    override fun getUri(): Uri? = openedUri

    override fun close() {
        try {
            stream?.close()
        } finally {
            stream = null
            request?.disconnect()
            request = null
            openedUri = null
            if (started) {
                started = false
                transferEnded()
            }
        }
    }
}
