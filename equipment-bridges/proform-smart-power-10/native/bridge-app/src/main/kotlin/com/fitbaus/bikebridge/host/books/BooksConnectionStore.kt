// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import android.content.Context
import com.fitbaus.bikebridge.host.credentials.AndroidCredentialKeys
import org.json.JSONObject

internal class BooksConnectionStore(context: Context) {
    private val app = context.applicationContext
    private val credentialsEnvelope = AndroidCredentialKeys(app, ALIAS, "CN=FitBaus Audiobookshelf").connectionEnvelope(32_768)
    private val prefs = app.getSharedPreferences("fitbaus_audiobookshelf", Context.MODE_PRIVATE)

    private var cached: BooksConnection? = null
    private var cachedEnvelope: String? = null

    fun load(): BooksConnection? = synchronized(LOCK) {
        val envelope = prefs.getString(RECORD, null) ?: return@synchronized null
        if (cachedEnvelope == envelope) cached?.let { return@synchronized it }
        val json = JSONObject(credentialsEnvelope.decrypt(envelope))
        val refresh = if (json.isNull("refreshToken")) null else json.getString("refreshToken")
        val connection = BooksConnection(json.getString("address"), BooksCredentials(json.getString("token"), refresh))
        bind(connection, envelope)
        connection
    }

    fun prepare(connection: BooksConnection): String = prepare(connection.address, connection.session.credentials())

    private fun prepare(address: String, credentials: BooksCredentials): String {
        val clear = JSONObject().put("address", address).put("token", credentials.accessToken)
            .put("refreshToken", credentials.refreshToken ?: JSONObject.NULL).toString()
        return credentialsEnvelope.encrypt(clear)
    }

    fun save(connection: BooksConnection, envelope: String) = synchronized(LOCK) {
        check(prefs.edit().putString(RECORD, envelope).commit())
        bind(connection, envelope)
    }

    private fun bind(connection: BooksConnection, envelope: String) {
        cached = connection
        cachedEnvelope = envelope
        var expected = envelope
        connection.session.onRefresh { credentials ->
            val replacement = prepare(connection.address, credentials)
            synchronized(LOCK) {
                check(prefs.getString(RECORD, null) == expected)
                check(prefs.edit().putString(RECORD, replacement).commit())
                expected = replacement
                if (cached === connection) cachedEnvelope = replacement
            }
        }
    }

    fun clear() = synchronized(LOCK) {
        check(prefs.edit().remove(RECORD).commit())
        cached = null
        cachedEnvelope = null
    }

    private companion object {
        val LOCK = Any()
        const val ALIAS = "fitbaus_audiobookshelf_v1"
        const val RECORD = "connection_encrypted"
    }
}
