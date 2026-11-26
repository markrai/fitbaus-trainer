// SPDX-License-Identifier: AGPL-3.0-only

@file:Suppress("DEPRECATION")

package com.fitbaus.bikebridge.host.credentials

import android.content.Context
import android.os.Build
import android.security.KeyPairGeneratorSpec
import android.util.Base64
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.util.Date
import javax.crypto.Cipher
import javax.security.auth.x500.X500Principal

internal class AndroidCredentialKeys(
    context: Context,
    private val alias: String,
    private val subject: String,
) {
    private val app = context.applicationContext

    fun rsaCipher(): Cipher = if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.LOLLIPOP_MR1) {
        Cipher.getInstance("RSA/ECB/PKCS1Padding", "AndroidOpenSSL")
    } else {
        Cipher.getInstance("RSA/ECB/PKCS1Padding")
    }

    fun privateKey(createIfMissing: Boolean = false): PrivateKey =
        (if (createIfMissing) ensureKey() else store()).getKey(alias, null) as PrivateKey

    fun publicKey() = ensureKey().getCertificate(alias).publicKey

    fun connectionEnvelope(maxEncryptedBytes: Int) = ConnectionCredentialEnvelope(
        wrapKey = { key -> rsaCipher().apply { init(Cipher.ENCRYPT_MODE, publicKey()) }.doFinal(key) },
        unwrapKey = { wrapped -> rsaCipher().apply { init(Cipher.DECRYPT_MODE, privateKey()) }.doFinal(wrapped) },
        encodeBase64 = { Base64.encodeToString(it, Base64.NO_WRAP) },
        decodeBase64 = { Base64.decode(it, Base64.NO_WRAP) },
        maxEncryptedBytes = maxEncryptedBytes,
    )

    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun ensureKey(): KeyStore = synchronized(keyCreationLock) {
        val existing = store()
        if (existing.containsAlias(alias)) return@synchronized existing
        val now = System.currentTimeMillis()
        val spec = KeyPairGeneratorSpec.Builder(app)
            .setAlias(alias)
            .setSubject(X500Principal(subject))
            .setSerialNumber(BigInteger.ONE)
            .setStartDate(Date(now - 60_000))
            .setEndDate(Date(now + 20L * 365 * 24 * 60 * 60 * 1000))
            .build()
        KeyPairGenerator.getInstance("RSA", "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
        store()
    }

    private companion object {
        val keyCreationLock = Any()
    }
}
