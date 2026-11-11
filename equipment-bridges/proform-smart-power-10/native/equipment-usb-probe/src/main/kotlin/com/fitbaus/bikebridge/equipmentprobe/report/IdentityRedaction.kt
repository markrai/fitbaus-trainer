// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe.report

internal object IdentityRedaction {
    private val SENSITIVE_KEYS = listOf(
        "serial",
        "part",
        "model",
        "authorization",
        "hash",
        "unlock",
        "security",
    )

    fun summarizeIdentityPresence(
        softwareVersion: Int?,
        serialPresent: Boolean,
        modelPresent: Boolean,
        partPresent: Boolean,
        masterLibraryPresent: Boolean,
    ): String {
        return buildString {
            append("softwareVersion=")
            append(softwareVersion?.toString() ?: "absent")
            append(" serialPresent=")
            append(serialPresent)
            append(" modelPresent=")
            append(modelPresent)
            append(" partPresent=")
            append(partPresent)
            append(" masterLibraryPresent=")
            append(masterLibraryPresent)
        }
    }

    fun containsSensitiveToken(text: String): Boolean {
        val lower = text.lowercase()
        return SENSITIVE_KEYS.any { key ->
            Regex("""(?<![a-z0-9])$key(?![a-z0-9])""").containsMatchIn(lower)
        }
    }

    fun safeDiagnosticMessage(category: String): String = category
}
