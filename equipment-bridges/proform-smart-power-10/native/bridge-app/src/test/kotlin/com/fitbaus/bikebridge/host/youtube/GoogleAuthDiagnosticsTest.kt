// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.json.JSONException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.IOException

class GoogleAuthDiagnosticsTest {
    @Test
    fun pendingAndSlowDownAreAllowedButRemainNonfatal() {
        assertEquals("authorization_pending",
            GoogleAuthDiagnostics.oauthCode("""{"error":"authorization_pending"}"""))
        assertEquals("slow_down",
            GoogleAuthDiagnostics.oauthCode("""{"error":"slow_down"}"""))
    }

    @Test
    fun invalidClientExplainsWhyDeviceCodeCanAppearThenPollingFails() {
        val failure = GoogleOAuthHttpFailure(GoogleAuthStage.TokenPoll, 401, "invalid_client")
        val message = GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll, failure)
        assertTrue(message.contains("invalid_client (HTTP 401)"))
        assertTrue(message.contains("TV OAuth client ID and secret"))
        assertTrue(message.contains("token polling"))
    }

    @Test
    fun unknownGoogleErrorAndArbitraryResponseCannotBeEchoed() {
        val body = """{"error":"client_secret=DO-NOT-PRINT","error_description":"refresh_token=DO-NOT-PRINT"}"""
        val error = GoogleAuthDiagnostics.oauthCode(body)
        assertEquals("unrecognized_error", error)
        val failure = GoogleOAuthHttpFailure(GoogleAuthStage.TokenPoll, 400, error)
        val message = GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll, failure)
        assertTrue(message.contains("unrecognized_error (HTTP 400)"))
        assertFalse(message.contains("DO-NOT-PRINT"))
        assertFalse(message.contains("client_secret"))
        assertFalse(message.contains("refresh_token"))
        assertEquals("unrecognized_error", GoogleAuthDiagnostics.oauthCode("not-json"))
        assertEquals("unrecognized_error", GoogleAuthDiagnostics.oauthCode("{}"))
    }

    @Test
    fun otherGoogleFailuresHaveActionableButBoundedDetails() {
        val grant = GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll,
            GoogleOAuthHttpFailure(GoogleAuthStage.TokenPoll, 400, "invalid_grant"))
        assertTrue(grant.contains("fresh device code"))
        val policy = GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll,
            GoogleOAuthHttpFailure(GoogleAuthStage.TokenPoll, 403, "org_internal"))
        assertTrue(policy.contains("audience"))
        val unsupported = GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll,
            GoogleOAuthHttpFailure(GoogleAuthStage.TokenPoll, 400, "unsupported_grant_type"))
        assertTrue(unsupported.contains("OAuth device-flow"))
        val invalidCode = GoogleOAuthHttpFailure(GoogleAuthStage.TokenPoll, 99999, "evil_code_deviceSecret")
        val bounded = GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll, invalidCode)
        assertTrue(bounded.contains("unrecognized_error (HTTP 599)"))
        assertFalse(bounded.contains("evil_code"))
    }

    @Test
    fun localNetworkParsingAndCredentialStorageFailuresRemainDistinct() {
        val io = GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll, IOException("Bearer private-secret"))
        assertTrue(io.contains("Network or TLS"))
        assertFalse(io.contains("private-secret"))
        val parsing = GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll, JSONException("client_secret=private-secret"))
        assertTrue(parsing.contains("unexpected response"))
        assertFalse(parsing.contains("private-secret"))
        val credential = GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll, GoogleCredentialStorageFailure())
        assertTrue(credential.contains("encrypted Google credentials"))
        val local = GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll, IllegalStateException("refresh_token=private-secret"))
        assertTrue(local.contains("local error"))
        assertFalse(local.contains("private-secret"))
    }
}
