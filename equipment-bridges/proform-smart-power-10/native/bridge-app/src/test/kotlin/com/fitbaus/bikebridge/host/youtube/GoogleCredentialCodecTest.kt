// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class GoogleCredentialCodecTest {
    private val key = SecretKeySpec(ByteArray(16) { (it + 1).toByte() }, "AES")
    private val other = SecretKeySpec(ByteArray(16) { (it + 13).toByte() }, "AES")

    @Test
    fun newFormatEncryptsWithExplicitTwelveByteIvAndSurvivesReload() {
        val clear = "client_secret_example_123"
        val cipher = GoogleCredentialCodec.encrypt(clear, key)
        assertTrue(cipher.size >= 12 + 16 + clear.length)
        assertEquals(clear, GoogleCredentialCodec.decrypt(cipher.clone(), key))
        val second = GoogleCredentialCodec.encrypt(clear, key)
        assertNotEquals(cipher.toList(), second.toList())
        assertFalse(cipher.toString(Charsets.ISO_8859_1).contains(clear))
    }

    @Test
    fun oldTwelveAndSixteenByteIvFormatsRemainReadable() {
        val clear = "old encrypted refresh token"
        for (ivSize in listOf(12, 16)) {
            val iv = ByteArray(ivSize) { (it + 21).toByte() }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            val legacy = iv + cipher.doFinal(clear.toByteArray(Charsets.UTF_8))
            assertEquals(clear, GoogleCredentialCodec.decrypt(legacy, key, legacy = true))
        }
    }

    @Test
    fun wrongKeyTamperingAndTruncationFailClosed() {
        val data = GoogleCredentialCodec.encrypt("secret", key)
        assertThrows(GeneralSecurityException::class.java) {
            GoogleCredentialCodec.decrypt(data, other)
        }
        val modified = data.clone()
        modified[modified.lastIndex] = (modified.last().toInt() xor 0x7f).toByte()
        assertThrows(GeneralSecurityException::class.java) {
            GoogleCredentialCodec.decrypt(modified, key)
        }
        assertThrows(GeneralSecurityException::class.java) {
            GoogleCredentialCodec.decrypt(byteArrayOf(1, 2, 3), key, legacy = true)
        }
    }

    @Test
    fun oldCiphertextDoesNotSilentlyBecomeNewFormat() {
        val iv = ByteArray(12) { it.toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        val legacy = iv + cipher.doFinal("legacy".toByteArray(Charsets.UTF_8))
        assertEquals("legacy", GoogleCredentialCodec.decrypt(legacy, key, legacy = true))
        assertEquals("legacy", GoogleCredentialCodec.decrypt(legacy, key))
        assertEquals("v2:", GoogleCredentialCodec.FORMAT_PREFIX)
    }
}
