// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class YouTubeCredentialsImportTest {
    @Test
    fun parsesDownloadedInstalledCredentials() {
        val client = YouTubeCredentialsImport.parse(
            """{"installed":{"client_id":"1234567-example.apps.googleusercontent.com","project_id":"fitbaus-youtube","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","client_secret":"GOCSPX-example"}}""",
        )
        assertEquals("1234567-example.apps.googleusercontent.com", client.id)
        assertEquals("GOCSPX-example", client.secret)
    }

    @Test
    fun rejectsWebClientsAndMissingSecrets() {
        assertThrows(Exception::class.java) {
            YouTubeCredentialsImport.parse("""{"web":{"client_id":"test.apps.googleusercontent.com","client_secret":"secret"}}""")
        }
        assertThrows(Exception::class.java) {
            YouTubeCredentialsImport.parse("""{"installed":{"client_id":"test.apps.googleusercontent.com"}}""")
        }
        assertThrows(Exception::class.java) {
            YouTubeCredentialsImport.parse("""{"installed":{"client_id":"bad-id","client_secret":"secret"}}""")
        }
    }

    @Test
    fun rejectsOversizedOrInvalidInput() {
        assertThrows(Exception::class.java) {
            YouTubeCredentialsImport.parse("a".repeat(16385))
        }
        assertThrows(Exception::class.java) {
            YouTubeCredentialsImport.parse("{}")
        }
    }

    @Test
    fun acceptsOnlyRandomHexNonces() {
        assertTrue(YouTubeCredentialsImport.validNonce("a9".repeat(16)))
        assertFalse(YouTubeCredentialsImport.validNonce("../auth.json"))
        assertFalse(YouTubeCredentialsImport.validNonce("A9".repeat(16)))
        assertFalse(YouTubeCredentialsImport.validNonce(null))
    }
}
