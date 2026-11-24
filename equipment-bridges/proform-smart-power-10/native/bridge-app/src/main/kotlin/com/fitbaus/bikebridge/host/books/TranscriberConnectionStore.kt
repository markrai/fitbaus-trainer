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

internal class TranscriberConnectionStore(context: Context) {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("fitbaus_transcriber", Context.MODE_PRIVATE)

    fun load(): TranscriberConnection? = synchronized(LOCK) {
        val envelope = prefs.getString(RECORD, null) ?: return@synchronized null
        val parts = envelope.split(':')
        require(parts.size == 3 && parts[0] == "v1")
        val key = rsa().apply { init(Cipher.DECRYPT_MODE, store().getKey(ALIAS, null)) }
            .doFinal(Base64.decode(parts[1], Base64.NO_WRAP))
        require(key.size == 16)
        val bytes = Base64.decode(parts[2], Base64.NO_WRAP)
        require(bytes.size in 29..8192)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        val json = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        TranscriberConnection(json.getString("address"), json.getString("token"))
    }

    fun save(connection: TranscriberConnection) = synchronized(LOCK) {
        val key = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val wrapped = rsa().apply { init(Cipher.ENCRYPT_MODE, ensureKey().getCertificate(ALIAS).publicKey) }.doFinal(key)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val clear = JSONObject().put("address", connection.address).put("token", connection.token).toString()
        val encrypted = iv + cipher.doFinal(clear.toByteArray(Charsets.UTF_8))
        val envelope = "v1:" + Base64.encodeToString(wrapped, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)
        check(prefs.edit().putString(RECORD, envelope).commit())
    }

    fun clear() = synchronized(LOCK) {
        check(prefs.edit().remove(RECORD).commit())
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
            .setSubject(X500Principal("CN=FitBaus Transcriber"))
            .setSerialNumber(BigInteger.ONE)
            .setStartDate(Date(now - 60_000))
            .setEndDate(Date(now + 20L * 365 * 24 * 60 * 60 * 1000))
            .build()
        KeyPairGenerator.getInstance("RSA", "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
        return store()
    }

    private companion object {
        val LOCK = Any()
        const val ALIAS = "fitbaus_transcriber_v1"
        const val RECORD = "connection_encrypted"
    }
}
