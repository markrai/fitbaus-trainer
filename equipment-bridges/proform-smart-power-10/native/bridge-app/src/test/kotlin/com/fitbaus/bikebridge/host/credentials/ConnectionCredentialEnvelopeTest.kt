package com.fitbaus.bikebridge.host.credentials

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.security.GeneralSecurityException
import java.security.KeyPairGenerator
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class ConnectionCredentialEnvelopeTest {
    private val rsa = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()

    private fun wrap(key: ByteArray): ByteArray = Cipher.getInstance("RSA/ECB/PKCS1Padding").apply {
        init(Cipher.ENCRYPT_MODE, rsa.public)
    }.doFinal(key)

    private fun unwrap(wrapped: ByteArray): ByteArray = Cipher.getInstance("RSA/ECB/PKCS1Padding").apply {
        init(Cipher.DECRYPT_MODE, rsa.private)
    }.doFinal(wrapped)

    private fun encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    private fun decode(value: String): ByteArray = Base64.getDecoder().decode(value)

    private fun envelope(limit: Int = 32_768) =
        ConnectionCredentialEnvelope(::wrap, ::unwrap, ::encode, ::decode, limit)

    private fun oldEnvelope(clear: String, key: ByteArray = ByteArray(16) { it.toByte() }): String {
        val iv = ByteArray(12) { (it + 20).toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return "v1:" + encode(wrap(key)) + ":" + encode(iv + cipher.doFinal(clear.toByteArray(Charsets.UTF_8)))
    }

    private fun oldDecrypt(value: String): String {
        val parts = value.split(':')
        assertEquals("v1", parts[0])
        assertEquals(3, parts.size)
        val key = unwrap(decode(parts[1]))
        assertEquals(16, key.size)
        val bytes = decode(parts[2])
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }

    @Test
    fun originalAudiobookshelfAndTranscriberRecordsRemainReadable() {
        val books = """{"address":"https://books.example","token":"access","refreshToken":"refresh"}"""
        val legacyBooks = """{"address":"https://books.example","token":"access","refreshToken":null}"""
        val transcriber = """{"address":"http://192.168.1.1:8765","token":"paired"}"""
        assertEquals(books, envelope().decrypt(oldEnvelope(books)))
        assertEquals(legacyBooks, envelope().decrypt(oldEnvelope(legacyBooks)))
        assertEquals(transcriber, envelope(8192).decrypt(oldEnvelope(transcriber)))
    }

    @Test
    fun newEnvelopeCanBeReadByOriginalDecoderAndUsesFreshKeysAndNonces() {
        val clear = """{"address":"https://example.test","token":"secret"}"""
        val first = envelope().encrypt(clear)
        val second = envelope().encrypt(clear)
        assertEquals(clear, envelope().decrypt(first))
        assertEquals(clear, oldDecrypt(first))
        assertEquals(clear, oldDecrypt(second))
        assertNotEquals(unwrap(decode(first.split(':')[1])).toList(), unwrap(decode(second.split(':')[1])).toList())
        assertNotEquals(decode(first.split(':')[2]).take(12), decode(second.split(':')[2]).take(12))
        assertFalse(first.contains(clear))
    }

    @Test
    fun perStoreReadLimitsAndMinimumSizeRemainDistinct() {
        val large = "a".repeat(8192)
        val value = envelope().encrypt(large)
        assertEquals(large, envelope().decrypt(value))
        assertThrows(IllegalArgumentException::class.java) { envelope(8192).decrypt(value) }
        val exact = "x".repeat(8192 - 28)
        assertEquals(exact, envelope(8192).decrypt(envelope().encrypt(exact)))
        assertThrows(IllegalArgumentException::class.java) { envelope().decrypt(envelope().encrypt("")) }
        assertThrows(IllegalArgumentException::class.java) { envelope().decrypt(envelope().encrypt("x".repeat(32_769 - 28))) }
    }

    @Test
    fun malformedVersionKeyAndTamperedCiphertextFailClosed() {
        val value = envelope().encrypt("secret")
        assertThrows(IllegalArgumentException::class.java) { envelope().decrypt(value.replaceFirst("v1:", "v2:")) }
        assertThrows(IllegalArgumentException::class.java) { envelope().decrypt("v1:") }
        val parts = value.split(':')
        val badKey = "v1:" + encode(wrap(ByteArray(32))) + ":" + parts[2]
        assertThrows(IllegalArgumentException::class.java) { envelope().decrypt(badKey) }
        val modified = decode(parts[2])
        modified[modified.lastIndex] = (modified.last().toInt() xor 1).toByte()
        assertThrows(GeneralSecurityException::class.java) {
            envelope().decrypt("v1:" + parts[1] + ":" + encode(modified))
        }
    }
}
