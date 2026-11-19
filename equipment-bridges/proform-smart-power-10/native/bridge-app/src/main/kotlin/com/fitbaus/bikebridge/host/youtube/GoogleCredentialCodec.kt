// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import java.security.GeneralSecurityException
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal object GoogleCredentialCodec {
    const val FORMAT_PREFIX = "v2:"
    private const val IV_BYTES = 12
    private const val LEGACY_IV_BYTES = 16
    private const val TAG_BYTES = 16
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    fun encrypt(clear: String, key: SecretKeySpec): ByteArray {
        val iv = ByteArray(IV_BYTES)
        SecureRandom().nextBytes(iv)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        return iv + cipher.doFinal(clear.toByteArray(Charsets.UTF_8))
    }

    fun decrypt(bytes: ByteArray, key: SecretKeySpec, legacy: Boolean = false): String {
        if (!legacy) return decryptWithIv(bytes, key, IV_BYTES)
        return try {
            decryptWithIv(bytes, key, IV_BYTES)
        } catch (first: GeneralSecurityException) {
            try {
                decryptWithIv(bytes, key, LEGACY_IV_BYTES)
            } catch (_: GeneralSecurityException) {
                throw first
            }
        }
    }

    private fun decryptWithIv(bytes: ByteArray, key: SecretKeySpec, ivSize: Int): String {
        if (bytes.size < ivSize + TAG_BYTES) {
            throw GeneralSecurityException("Credential envelope too short")
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, ivSize)))
        return String(cipher.doFinal(bytes.copyOfRange(ivSize, bytes.size)), Charsets.UTF_8)
    }
}
