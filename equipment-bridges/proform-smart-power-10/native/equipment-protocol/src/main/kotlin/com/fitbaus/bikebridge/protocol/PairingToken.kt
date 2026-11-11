// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import java.security.MessageDigest
import java.security.SecureRandom

public object PairingToken {
    public const val LENGTH: Int = 8
    public const val GENERATED_ALPHABET: String = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

    public fun generate(random: SecureRandom = SecureRandom()): String {
        val out = CharArray(LENGTH)
        for (i in out.indices) {
            out[i] = GENERATED_ALPHABET[random.nextInt(GENERATED_ALPHABET.length)]
        }
        return String(out)
    }

    public fun normalize(raw: String?): String? {
        if (raw == null) return null
        val sb = StringBuilder(raw.length)
        for (ch in raw) {
            if (ch == ' ' || ch == '-' || ch == '\t') continue
            sb.append(ch.uppercaseChar())
        }
        val value = sb.toString()
        return if (isWellFormed(value)) value else null
    }

    public fun isWellFormed(value: String?): Boolean {
        if (value == null || value.length != LENGTH) return false
        for (ch in value) {
            if (ch !in '0'..'9' && ch !in 'A'..'Z') return false
        }
        return true
    }

    public fun matches(expected: String?, presented: String?): Boolean {
        val want = normalize(expected) ?: return false
        val got = normalize(presented) ?: return false
        return MessageDigest.isEqual(want.toByteArray(Charsets.US_ASCII), got.toByteArray(Charsets.US_ASCII))
    }

    public fun grouped(value: String): String = value.chunked(4).joinToString(" ")
}
