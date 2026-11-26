// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.credentials

import java.security.SecureRandom
import javax.crypto.spec.SecretKeySpec

internal class ConnectionCredentialEnvelope(
    private val wrapKey: (ByteArray) -> ByteArray,
    private val unwrapKey: (ByteArray) -> ByteArray,
    private val encodeBase64: (ByteArray) -> String,
    private val decodeBase64: (String) -> ByteArray,
    private val maxEncryptedBytes: Int,
) {
    fun encrypt(clear: String): String {
        val key = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val wrapped = wrapKey(key)
        val encrypted = CredentialGcm.encrypt(clear, SecretKeySpec(key, "AES"))
        return "v1:" + encodeBase64(wrapped) + ":" + encodeBase64(encrypted)
    }

    fun decrypt(envelope: String): String {
        val parts = envelope.split(':')
        require(parts.size == 3 && parts[0] == "v1")
        val key = unwrapKey(decodeBase64(parts[1]))
        require(key.size == 16)
        val bytes = decodeBase64(parts[2])
        require(bytes.size in 29..maxEncryptedBytes)
        return CredentialGcm.decrypt(bytes, SecretKeySpec(key, "AES"))
    }
}
