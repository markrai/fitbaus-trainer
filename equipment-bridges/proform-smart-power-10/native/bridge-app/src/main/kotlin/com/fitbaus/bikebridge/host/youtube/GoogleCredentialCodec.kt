// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import com.fitbaus.bikebridge.host.credentials.CredentialGcm
import java.security.GeneralSecurityException
import javax.crypto.spec.SecretKeySpec

internal object GoogleCredentialCodec {
    const val FORMAT_PREFIX = "v2:"
    private const val IV_BYTES = 12
    private const val LEGACY_IV_BYTES = 16
    fun encrypt(clear: String, key: SecretKeySpec): ByteArray =
        CredentialGcm.encrypt(clear, key)

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
        return CredentialGcm.decrypt(bytes, key, ivSize)
    }
}
