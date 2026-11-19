// SPDX-License-Identifier: AGPL-3.0-only

@file:Suppress("DEPRECATION")

package com.fitbaus.bikebridge.host.youtube

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
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
        guarded(GoogleCredentialFailurePoint.Verification) {
            check(decrypt(encrypted) == client.secret)
        }
        persist(prefs.edit().putString(KEY_CLIENT_ID, client.id)
            .putString(KEY_CLIENT_SECRET, encrypted).remove(KEY_REFRESH))
        guarded(GoogleCredentialFailurePoint.Verification) {
            check(client() == client)
        }
    }

    override fun refreshToken(): String? =
        prefs.getString(KEY_REFRESH, null)?.let { decrypt(it) }

    override fun saveRefreshToken(token: String) {
        require(token.isNotBlank() && token.length <= 8192)
        val encrypted = encrypt(token)
        guarded(GoogleCredentialFailurePoint.Verification) {
            check(decrypt(encrypted) == token)
        }
        persist(prefs.edit().putString(KEY_REFRESH, encrypted))
        guarded(GoogleCredentialFailurePoint.Verification) {
            check(refreshToken() == token)
        }
    }

    override fun clearRefreshToken() {
        persist(prefs.edit().remove(KEY_REFRESH))
    }

    private fun persist(editor: SharedPreferences.Editor) {
        guarded(GoogleCredentialFailurePoint.Persistence) {
            check(editor.commit())
        }
    }

    private fun aesKey(): SecretKeySpec {
        val wrapped = prefs.getString(KEY_WRAPPED_AES, null)
        if (wrapped != null) {
            val privateKey = guarded(GoogleCredentialFailurePoint.Keystore) { privateKey() }
            val bytes = guarded(GoogleCredentialFailurePoint.RsaUnwrap) {
                val cipher = rsaCipher()
                cipher.init(Cipher.DECRYPT_MODE, privateKey)
                cipher.doFinal(Base64.decode(wrapped, Base64.NO_WRAP))
            }
            if (bytes.size != 16) throw GoogleCredentialStorageFailure(GoogleCredentialFailurePoint.RsaUnwrap)
            return SecretKeySpec(bytes, "AES")
        }
        val generated = ByteArray(16)
        SecureRandom().nextBytes(generated)
        val publicKey = guarded(GoogleCredentialFailurePoint.Keystore) { publicKey() }
        val encrypted = guarded(GoogleCredentialFailurePoint.RsaWrap) {
            val rsa = rsaCipher()
            rsa.init(Cipher.ENCRYPT_MODE, publicKey)
            rsa.doFinal(generated)
        }
        persist(prefs.edit().putString(KEY_WRAPPED_AES, Base64.encodeToString(encrypted, Base64.NO_WRAP)))
        return SecretKeySpec(generated, "AES")
    }

    private fun encrypt(clear: String): String {
        val key = aesKey()
        val bytes = guarded(GoogleCredentialFailurePoint.AesEncrypt) {
            GoogleCredentialCodec.encrypt(clear, key)
        }
        return GoogleCredentialCodec.FORMAT_PREFIX + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String {
        val isCurrentFormat = encoded.startsWith(GoogleCredentialCodec.FORMAT_PREFIX)
        val payload = if (isCurrentFormat) encoded.substring(GoogleCredentialCodec.FORMAT_PREFIX.length) else encoded
        val key = aesKey()
        return guarded(GoogleCredentialFailurePoint.AesDecrypt) {
            GoogleCredentialCodec.decrypt(Base64.decode(payload, Base64.NO_WRAP), key, legacy = !isCurrentFormat)
        }
    }

    private fun rsaCipher(): Cipher =
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.LOLLIPOP_MR1) {
            Cipher.getInstance(RSA_TRANSFORM, "AndroidOpenSSL")
        } else {
            Cipher.getInstance(RSA_TRANSFORM)
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

    private inline fun <T> guarded(point: GoogleCredentialFailurePoint, block: () -> T): T {
        try {
            return block()
        } catch (failure: GoogleCredentialStorageFailure) {
            throw failure
        } catch (_: Exception) {
            throw GoogleCredentialStorageFailure(point)
        }
    }

    private companion object {
        const val PREFS = "fitbaus_google_youtube_account"
        const val KEY_ALIAS = "fitbaus_youtube_account_v1"
        const val KEY_CLIENT_ID = "client_id"
        const val KEY_CLIENT_SECRET = "client_secret_encrypted"
        const val KEY_REFRESH = "refresh_token_encrypted"
        const val KEY_WRAPPED_AES = "wrapped_aes"
        const val RSA_TRANSFORM = "RSA/ECB/PKCS1Padding"
    }
}
