// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.IOException

class GoogleYouTubeApiTest {
    private class Http : GoogleHttp {
        var nextGet = GoogleHttpResponse(200, "{}")
        var nextPost = GoogleHttpResponse(200, "{}")
        var url = ""
        var token = ""
        var fields: Map<String, String> = emptyMap()

        override fun get(url: String, token: String): GoogleHttpResponse {
            this.url = url
            this.token = token
            return nextGet
        }

        override fun post(url: String, fields: Map<String, String>): GoogleHttpResponse {
            this.url = url
            this.fields = fields
            return nextPost
        }
    }

    private val client = GoogleClient("test.apps.googleusercontent.com", "dummy-secret")

    @Test
    fun deviceAuthorizationUsesOnlyReadOnlyYouTubeScope() {
        val http = Http()
        http.nextPost = GoogleHttpResponse(200,
            """{"device_code":"internal-device-code","user_code":"ABCD-EFGH","verification_url":"https://www.google.com/device","expires_in":900,"interval":5}""")
        val code = GoogleYouTubeApi(http).requestCode(client)
        assertEquals("ABCD-EFGH", code.userCode)
        assertEquals("internal-device-code", code.code)
        assertEquals(null, code.verificationCompleteUrl)
        assertEquals(5, code.intervalSeconds)
        assertEquals("https://oauth2.googleapis.com/device/code", http.url)
        assertEquals(mapOf("client_id" to client.id, "scope" to GoogleYouTubeApi.YOUTUBE_READONLY), http.fields)
        assertFalse(http.fields.containsKey("client_secret"))
    }

    @Test
    fun serverSuppliedCompleteUrlIsPreservedForQrHandoff() {
        val http = Http()
        val direct = "https://www.google.com/device?user_code=ABCD-EFGH"
        http.nextPost = GoogleHttpResponse(200,
            """{"device_code":"internal-device-code","user_code":"ABCD-EFGH","verification_url":"https://www.google.com/device","verification_uri_complete":"${direct}","expires_in":900,"interval":5}""")
        val code = GoogleYouTubeApi(http).requestCode(client)
        assertEquals(direct, code.verificationCompleteUrl)
        assertEquals("https://www.google.com/device", code.verificationUrl)
    }

    @Test
    fun untrustedServerCompleteUrlIsIgnoredWithoutBreakingManualAuthorization() {
        val http = Http()
        http.nextPost = GoogleHttpResponse(200,
            """{"device_code":"x","user_code":"CODE","verification_url":"https://www.google.com/device","verification_uri_complete":"https://www.google.com.evil.invalid/device?code=CODE","expires_in":900,"interval":5}""")
        val code = GoogleYouTubeApi(http).requestCode(client)
        assertEquals(null, code.verificationCompleteUrl)
        assertEquals("https://www.google.com/device", code.verificationUrl)
    }

    @Test
    fun deviceCodeLifetimeComesFromGoogleAndCanExceedItsExampleThirtyMinutes() {
        val http = Http()
        http.nextPost = GoogleHttpResponse(200,
            """{"device_code":"x","user_code":"CODE","verification_url":"https://www.google.com/device","expires_in":3600,"interval":5}""")
        val code = GoogleYouTubeApi(http).requestCode(client)
        assertEquals(3600, code.expiresInSeconds)
        assertEquals(3600_000L, GoogleDeviceCodeLifetime.remainingMs(
            GoogleDeviceCodeLifetime.deadline(100L, code.expiresInSeconds), 100L))
    }

    @Test
    fun unexpectedVerificationUrlsAreRejected() {
        val http = Http()
        http.nextPost = GoogleHttpResponse(200,
            """{"device_code":"x","user_code":"CODE","verification_url":"https://evil.invalid/device","expires_in":900,"interval":5}""")
        assertThrows(IOException::class.java) { GoogleYouTubeApi(http).requestCode(client) }
    }

    @Test
    fun pendingAndSlowDownAreHandledWithoutRepeatingAuthorization() {
        val http = Http()
        val api = GoogleYouTubeApi(http)
        http.nextPost = GoogleHttpResponse(428, """{"error":"authorization_pending"}""")
        assertEquals(GooglePollResult.Pending, api.poll(client, "device-secret"))
        http.nextPost = GoogleHttpResponse(403, """{"error":"slow_down"}""")
        assertEquals(GooglePollResult.SlowDown, api.poll(client, "device-secret"))
        assertEquals(client.secret, http.fields["client_secret"])
        assertEquals("device-secret", http.fields["device_code"])
        assertEquals(10, GooglePolling.interval(5, true))
        assertEquals(120, GooglePolling.interval(120, true))
    }

    @Test
    fun invalidClientOnFirstPollKeepsGoogleStatusAndSafeError() {
        val http = Http()
        http.nextPost = GoogleHttpResponse(401,
            """{"error":"invalid_client","error_description":"client_secret=DO-NOT-PRINT"}""")
        val error = assertThrows(GoogleOAuthHttpFailure::class.java) {
            GoogleYouTubeApi(http).poll(client, "device-secret")
        }
        assertEquals(GoogleAuthStage.TokenPoll, error.stage)
        assertEquals(401, error.httpStatus)
        assertEquals("invalid_client", error.oauthError)
        assertFalse(GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll, error).contains("DO-NOT-PRINT"))
    }

    @Test
    fun unsupportedGrantAndUnknownGoogleErrorStaySafelyClassified() {
        val http = Http()
        val api = GoogleYouTubeApi(http)
        http.nextPost = GoogleHttpResponse(400, """{"error":"unsupported_grant_type"}""")
        val unsupported = assertThrows(GoogleOAuthHttpFailure::class.java) {
            api.poll(client, "device-secret")
        }
        assertEquals("unsupported_grant_type", unsupported.oauthError)
        http.nextPost = GoogleHttpResponse(500,
            """{"error":"client_secret_DO-NOT-PRINT","error_description":"device-secret"}""")
        val unknown = assertThrows(GoogleOAuthHttpFailure::class.java) {
            api.poll(client, "device-secret")
        }
        assertEquals("unrecognized_error", unknown.oauthError)
        assertEquals(500, unknown.httpStatus)
        assertFalse(GoogleAuthDiagnostics.message(GoogleAuthStage.TokenPoll, unknown).contains("device-secret"))
    }

    @Test
    fun deviceCodeRequestClassifiesGoogleRejectionInsteadOfReauthorization() {
        val http = Http()
        http.nextPost = GoogleHttpResponse(401, """{"error":"invalid_client"}""")
        val error = assertThrows(GoogleOAuthHttpFailure::class.java) {
            GoogleYouTubeApi(http).requestCode(client)
        }
        assertEquals(GoogleAuthStage.DeviceCode, error.stage)
        assertEquals("invalid_client", error.oauthError)
    }

    @Test
    fun malformedGoogleSuccessIsDistinguishedFromNetworkFailure() {
        val http = Http()
        http.nextPost = GoogleHttpResponse(200, "this is not json")
        assertThrows(GoogleResponseFormatFailure::class.java) {
            GoogleYouTubeApi(http).poll(client, "device-secret")
        }
    }

    @Test
    fun authorizationRequiresTheRequestedScopeAndBearerToken() {
        val http = Http()
        val api = GoogleYouTubeApi(http)
        http.nextPost = GoogleHttpResponse(200,
            """{"access_token":"token","refresh_token":"refresh","token_type":"Bearer","scope":"https://www.googleapis.com/auth/youtube.readonly","expires_in":3600}""")
        val granted = assertInstanceOf(GooglePollResult.Authorized::class.java, api.poll(client, "device"))
        assertEquals("token", granted.grant.accessToken)
        assertEquals("refresh", granted.grant.refreshToken)
        http.nextPost = GoogleHttpResponse(200,
            """{"access_token":"token","refresh_token":"refresh","scope":"email","expires_in":3600}""")
        assertThrows(IOException::class.java) { api.poll(client, "device") }
    }

    @Test
    fun refreshRejectsRevokedCredentials() {
        val http = Http()
        http.nextPost = GoogleHttpResponse(400, """{"error":"invalid_grant"}""")
        assertThrows(GoogleReauthorizationRequired::class.java) {
            GoogleYouTubeApi(http).refresh(client, "refresh")
        }
    }

    @Test
    fun subscriptionsAndPlaylistsUseAuthenticatedMineEndpointsWithPaging() {
        val http = Http()
        val api = GoogleYouTubeApi(http)
        http.nextGet = GoogleHttpResponse(200, """{
            "nextPageToken":"page2",
            "items":[
                {"snippet":{"title":"Channel One","resourceId":{"channelId":"UCabcdefghijklmnopqrstuv"}}},
                {"snippet":{"title":"Missing","resourceId":{}}}
            ]
        }""")
        val subscriptions = api.subscriptions("access-token")
        assertEquals(1, subscriptions.items.size)
        assertEquals("Channel One", subscriptions.items.single().title)
        assertEquals("page2", subscriptions.next)
        assertTrue(http.url.contains("/subscriptions?"))
        assertTrue(http.url.contains("mine=true"))
        assertEquals("access-token", http.token)
        assertFalse(http.url.contains("access-token"))

        http.nextGet = GoogleHttpResponse(200,
            """{"items":[{"id":"PL123xyz","snippet":{"title":"Fitness"}}]}""")
        val playlists = api.playlists("access-token", "page2")
        assertEquals("Fitness", playlists.items.single().title)
        assertTrue(http.url.contains("pageToken=page2"))
        assertTrue(http.url.contains("/playlists?"))
        assertEquals(null, playlists.next)
    }

    @Test
    fun videoPublicationDateIsNotPlaylistInsertionDate() {
        val http = Http()
        http.nextGet = GoogleHttpResponse(200, """{"items":[
            {"snippet":{"title":"Published","publishedAt":"2026-11-20T12:00:00Z"},"contentDetails":{"videoId":"jNQXAC9IVRw","videoPublishedAt":"2022-01-01T00:00:00Z"}},
            {"snippet":{"title":"Playlist only","publishedAt":"2026-11-22T12:00:00Z"},"contentDetails":{"videoId":"abcdefghijk"}},
            {"snippet":{"title":"Invalid date","publishedAt":"2026-11-22T12:00:00Z"},"contentDetails":{"videoId":"23456789012","videoPublishedAt":"bad"}}
        ]}""")
        val videos = GoogleYouTubeApi(http).playlistItems("token", "PL123xyz").items
        assertEquals(3, videos.size)
        assertEquals(java.time.Instant.parse("2022-01-01T00:00:00Z").epochSecond, videos[0].publishedAtEpochSeconds)
        assertEquals(null, videos[1].publishedAtEpochSeconds)
        assertEquals(null, videos[2].publishedAtEpochSeconds)
    }

    @Test
    fun playlistItemsSkipDeletedPrivateOrInvalidVideos() {
        val http = Http()
        http.nextGet = GoogleHttpResponse(200, """{"items":[
          {"snippet":{"title":"Working video","channelTitle":"Science"},"contentDetails":{"videoId":"jNQXAC9IVRw"}},
          {"snippet":{"title":"Deleted video"},"contentDetails":{"videoId":"abcdefghijk"}},
          {"snippet":{"title":"Private video"},"contentDetails":{"videoId":"12345678901"}},
          {"snippet":{"title":"invalid"},"contentDetails":{"videoId":"bad"}}
        ]}""")
        val page = GoogleYouTubeApi(http).playlistItems("access-token", "PL123xyz")
        assertEquals(1, page.items.size)
        assertEquals("jNQXAC9IVRw", page.items.single().id)
        assertEquals("Science", page.items.single().channel)
        assertTrue(http.url.contains("playlistId=PL123xyz"))
    }
}
