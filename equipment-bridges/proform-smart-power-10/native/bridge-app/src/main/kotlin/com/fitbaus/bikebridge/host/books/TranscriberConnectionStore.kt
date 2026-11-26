package com.fitbaus.bikebridge.host.books

import android.content.Context
import com.fitbaus.bikebridge.host.credentials.AndroidCredentialKeys
import org.json.JSONObject

internal class TranscriberConnectionStore(context: Context) {
    private val app = context.applicationContext
    private val credentialsEnvelope = AndroidCredentialKeys(app, ALIAS, "CN=FitBaus Transcriber").connectionEnvelope(8192)
    private val prefs = app.getSharedPreferences("fitbaus_transcriber", Context.MODE_PRIVATE)

    fun load(): TranscriberConnection? = synchronized(LOCK) {
        val envelope = prefs.getString(RECORD, null) ?: return@synchronized null
        decode(envelope)
    }

    class RecordSnapshot internal constructor(private val store: TranscriberConnectionStore, private val envelope: String) {
        fun isCurrent(): Boolean = synchronized(LOCK) { store.prefs.getString(RECORD, null) == envelope }
        fun connection(): TranscriberConnection = synchronized(LOCK) {
            check(isCurrent())
            store.decode(envelope)
        }
    }

    fun snapshot(): RecordSnapshot? = synchronized(LOCK) {
        prefs.getString(RECORD, null)?.let { RecordSnapshot(this, it) }
    }

    private fun decode(envelope: String): TranscriberConnection {
        val json = JSONObject(credentialsEnvelope.decrypt(envelope))
        return TranscriberConnection(json.getString("address"), json.getString("token"))
    }

    fun save(connection: TranscriberConnection) = synchronized(LOCK) {
        val clear = JSONObject().put("address", connection.address).put("token", connection.token).toString()
        val envelope = credentialsEnvelope.encrypt(clear)
        check(prefs.edit().putString(RECORD, envelope).commit())
    }

    fun clear() = synchronized(LOCK) {
        check(prefs.edit().remove(RECORD).commit())
    }

    private companion object {
        val LOCK = Any()
        const val ALIAS = "fitbaus_transcriber_v1"
        const val RECORD = "connection_encrypted"
    }
}
