// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import android.content.Context
import android.content.SharedPreferences
import android.security.KeyPairGeneratorSpec
import android.util.Base64
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.util.Date
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec
import javax.security.auth.x500.X500Principal

internal interface GoogleAccountStore {
    fun hasAccount(): Boolean
    fun client(): GoogleClient?
    fun saveClient(client: GoogleClient)
    fun refreshToken(): String?
    fun saveRefreshToken(token: String)
    fun clearRefreshToken()
}

internal class AndroidGoogleAccountStore(context: Context) : GoogleAccountStore {
    private val app = context.applicationContext
    private val prefs: SharedPreferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun hasAccount(): Boolean = prefs.contains(KEY_REFRESH)

    override fun client(): GoogleClient? {
        val id = prefs.getString(KEY_CLIENT_ID, null)?.takeIf { it.isNotBlank() } ?: return null
        val encrypted = prefs.getString(KEY_CLIENT_SECRET, null) ?: return null
        return GoogleClient(id, decrypt(encrypted))
    }

    override fun saveClient(client: GoogleClient) {
        require(client.id.length in 10..256 && client.secret.length in 1..256)
        val encrypted = encrypt(client.secret)
        prefs.edit().putString(KEY_CLIENT_ID, client.id).putString(KEY_CLIENT_SECRET, encrypted)
            .remove(KEY_REFRESH).apply()
    }

    override fun refreshToken(): String? =
        prefs.getString(KEY_REFRESH, null)?.let { decrypt(it) }

    override fun saveRefreshToken(token: String) {
        require(token.isNotBlank() && token.length <= 8192)
        prefs.edit().putString(KEY_REFRESH, encrypt(token)).apply()
    }

    override fun clearRefreshToken() {
        prefs.edit().remove(KEY_REFRESH).apply()
    }

    private fun aesKey(): SecretKeySpec {
        val wrapped = prefs.getString(KEY_WRAPPED_AES, null)
        if (wrapped != null) {
            val cipher = Cipher.getInstance(RSA_TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, privateKey())
            val bytes = cipher.doFinal(Base64.decode(wrapped, Base64.NO_WRAP))
            require(bytes.size == 16)
            return SecretKeySpec(bytes, "AES")
        }
        val generated = ByteArray(16)
        SecureRandom().nextBytes(generated)
        val rsa = Cipher.getInstance(RSA_TRANSFORM)
        rsa.init(Cipher.ENCRYPT_MODE, publicKey())
        val encrypted = rsa.doFinal(generated)
        prefs.edit().putString(KEY_WRAPPED_AES, Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()
        return SecretKeySpec(generated, "AES")
    }

    private fun encrypt(clear: String): String {
        val cipher = Cipher.getInstance(AES_TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, aesKey())
        val ciphertext = cipher.doFinal(clear.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + ciphertext, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String {
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.size >= 12 + 16)
        val cipher = Cipher.getInstance(AES_TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, aesKey(), javax.crypto.spec.GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun ensureKey(): KeyStore {
        val store = keyStore()
        if (!store.containsAlias(KEY_ALIAS)) {
            val now = System.currentTimeMillis()
            val generator = KeyPairGenerator.getInstance("RSA", "AndroidKeyStore")
            val spec = KeyPairGeneratorSpec.Builder(app)
                .setAlias(KEY_ALIAS)
                .setSubject(X500Principal("CN=FitBaus YouTube Account"))
                .setSerialNumber(BigInteger.ONE)
                .setStartDate(Date(now - 60_000))
                .setEndDate(Date(now + 20L * 365 * 24 * 60 * 60 * 1000))
                .build()
            generator.initialize(spec)
            generator.generateKeyPair()
            return keyStore()
        }
        return store
    }

    private fun privateKey(): PrivateKey = ensureKey().getKey(KEY_ALIAS, null) as PrivateKey

    private fun publicKey() = ensureKey().getCertificate(KEY_ALIAS).publicKey

    private companion object {
        const val PREFS = "fitbaus_google_youtube_account"
        const val KEY_ALIAS = "fitbaus_youtube_account_v1"
        const val KEY_CLIENT_ID = "client_id"
        const val KEY_CLIENT_SECRET = "client_secret_encrypted"
        const val KEY_REFRESH = "refresh_token_encrypted"
        const val KEY_WRAPPED_AES = "wrapped_aes"
        const val RSA_TRANSFORM = "RSA/ECB/PKCS1Padding"
        const val AES_TRANSFORM = "AES/GCM/NoPadding"
    }
}
