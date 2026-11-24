// SPDX-License-Identifier: AGPL-3.0-only

@file:Suppress("DEPRECATION")

package com.fitbaus.bikebridge.host.books

import android.content.Context
import android.os.Build
import android.security.KeyPairGeneratorSpec
import android.util.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Date
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.security.auth.x500.X500Principal

internal class BooksConnectionStore(context: Context) {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("fitbaus_audiobookshelf", Context.MODE_PRIVATE)

    private var cached: BooksConnection? = null
    private var cachedEnvelope: String? = null

    fun load(): BooksConnection? = synchronized(LOCK) {
        val envelope = prefs.getString(RECORD, null) ?: return@synchronized null
        if (cachedEnvelope == envelope) cached?.let { return@synchronized it }
        val parts = envelope.split(':')
        require(parts.size == 3 && parts[0] == "v1")
        val key = rsa().apply {
            init(Cipher.DECRYPT_MODE, store().getKey(ALIAS, null))
        }.doFinal(Base64.decode(parts[1], Base64.NO_WRAP))
        require(key.size == 16)
        val bytes = Base64.decode(parts[2], Base64.NO_WRAP)
        require(bytes.size in 29..32_768)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        val json = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        val refresh = if (json.isNull("refreshToken")) null else json.getString("refreshToken")
        val connection = BooksConnection(json.getString("address"), BooksCredentials(json.getString("token"), refresh))
        bind(connection, envelope)
        connection
    }

    fun prepare(connection: BooksConnection): String = prepare(connection.address, connection.session.credentials())

    private fun prepare(address: String, credentials: BooksCredentials): String {
        val key = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val certificate = ensureKey().getCertificate(ALIAS)
        val wrapped = rsa().apply { init(Cipher.ENCRYPT_MODE, certificate.publicKey) }.doFinal(key)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val clear = JSONObject().put("address", address).put("token", credentials.accessToken)
            .put("refreshToken", credentials.refreshToken ?: JSONObject.NULL).toString()
        val encrypted = iv + cipher.doFinal(clear.toByteArray(Charsets.UTF_8))
        return "v1:" + Base64.encodeToString(wrapped, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)
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

    private fun rsa(): Cipher = if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.LOLLIPOP_MR1) {
        Cipher.getInstance("RSA/ECB/PKCS1Padding", "AndroidOpenSSL")
    } else {
        Cipher.getInstance("RSA/ECB/PKCS1Padding")
    }

    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun ensureKey(): KeyStore {
        val existing = store()
        if (existing.containsAlias(ALIAS)) return existing
        val now = System.currentTimeMillis()
        val spec = KeyPairGeneratorSpec.Builder(app)
            .setAlias(ALIAS)
            .setSubject(X500Principal("CN=FitBaus Audiobookshelf"))
            .setSerialNumber(BigInteger.ONE)
            .setStartDate(Date(now - 60_000))
            .setEndDate(Date(now + 20L * 365 * 24 * 60 * 60 * 1000))
            .build()
        KeyPairGenerator.getInstance("RSA", "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
        return store()
    }

    private companion object {
        val LOCK = Any()
        const val ALIAS = "fitbaus_audiobookshelf_v1"
        const val RECORD = "connection_encrypted"
    }
}
