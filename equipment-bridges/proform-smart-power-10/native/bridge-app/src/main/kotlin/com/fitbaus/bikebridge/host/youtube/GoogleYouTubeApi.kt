// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

internal data class GoogleClient(val id: String, val secret: String)

internal data class GoogleDeviceCode(
    val code: String,
    val userCode: String,
    val verificationUrl: String,
    val expiresInSeconds: Int,
    val intervalSeconds: Int,
    val verificationCompleteUrl: String? = null,
)

internal data class GoogleAccessGrant(
    val accessToken: String,
    val refreshToken: String?,
    val expiresInSeconds: Int,
)

internal sealed class GooglePollResult {
    data object Pending : GooglePollResult()
    data object SlowDown : GooglePollResult()
    data object Denied : GooglePollResult()
    data object Expired : GooglePollResult()
    data class Authorized(val grant: GoogleAccessGrant) : GooglePollResult()
}

internal data class GoogleEntry(val id: String, val title: String)

internal data class GoogleDatedVideo(val video: VideoSummary, val publishedAt: String)

internal data class GooglePage<T>(val items: List<T>, val next: String?)

internal data class GoogleHttpResponse(val status: Int, val body: String)

internal interface GoogleHttp {
    fun get(url: String, token: String): GoogleHttpResponse
    fun post(url: String, fields: Map<String, String>): GoogleHttpResponse
}

internal class GoogleUrlConnectionHttp : GoogleHttp {
    override fun get(url: String, token: String): GoogleHttpResponse =
        request(url, "GET", null, token)

    override fun post(url: String, fields: Map<String, String>): GoogleHttpResponse =
        request(
            url,
            "POST",
            fields.entries.joinToString("&") {
                URLEncoder.encode(it.key, "UTF-8") + "=" + URLEncoder.encode(it.value, "UTF-8")
            }.toByteArray(Charsets.UTF_8),
            null,
        )

    private fun request(url: String, method: String, body: ByteArray?, token: String?): GoogleHttpResponse {
        require(url.startsWith("https://oauth2.googleapis.com/") || url.startsWith("https://www.googleapis.com/youtube/v3/"))
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 15_000
        connection.instanceFollowRedirects = false
        connection.requestMethod = method
        connection.setRequestProperty("Accept", "application/json")
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token)
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connection.setFixedLengthStreamingMode(body.size)
        }
        try {
            if (body != null) connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val output = ByteArrayOutputStream()
            if (stream != null) stream.use { input ->
                val chunk = ByteArray(4096)
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    if (output.size() + n > MAX_RESPONSE_BYTES) throw IOException("Google response exceeds limit")
                    output.write(chunk, 0, n)
                }
            }
            return GoogleHttpResponse(status, output.toString("UTF-8"))
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 512 * 1024
    }
}

internal class GoogleYouTubeApi(private val http: GoogleHttp) {
    fun requestCode(client: GoogleClient): GoogleDeviceCode {
        val json = success(http.post(
            "https://oauth2.googleapis.com/device/code",
            mapOf("client_id" to client.id, "scope" to YOUTUBE_READONLY),
        ), GoogleAuthStage.DeviceCode)
        val verificationUrl = json.getString("verification_url")
        if (verificationUrl != "https://www.google.com/device" &&
            verificationUrl != "https://www.google.com/device/") {
            throw IOException("Unexpected Google verification URL")
        }
        val suppliedComplete = json.optString("verification_uri_complete").takeIf { it.isNotBlank() }
            ?: json.optString("verification_url_complete").takeIf { it.isNotBlank() }
        val scanUrl = GoogleDeviceVerification.scanUrl(verificationUrl, suppliedComplete)
        return GoogleDeviceCode(
            json.getString("device_code"),
            json.getString("user_code"),
            verificationUrl,
            json.getInt("expires_in").coerceIn(1, 86_400),
            json.optInt("interval", 5).coerceIn(5, 60),
            scanUrl.takeIf { it != verificationUrl },
        )
    }

    fun poll(client: GoogleClient, deviceCode: String): GooglePollResult {
        val response = http.post(
            "https://oauth2.googleapis.com/token",
            mapOf(
                "client_id" to client.id,
                "client_secret" to client.secret,
                "device_code" to deviceCode,
                "grant_type" to "urn:ietf:params:oauth:grant-type:device_code",
            ),
        )
        if (response.status in 200..299) {
            return GooglePollResult.Authorized(grant(success(response, GoogleAuthStage.TokenPoll)))
        }
        val error = GoogleAuthDiagnostics.oauthCode(response.body)
        return when (error) {
            "authorization_pending" -> GooglePollResult.Pending
            "slow_down" -> GooglePollResult.SlowDown
            "access_denied" -> GooglePollResult.Denied
            "expired_token" -> GooglePollResult.Expired
            else -> throw GoogleOAuthHttpFailure(GoogleAuthStage.TokenPoll, response.status, error)
        }
    }

    fun refresh(client: GoogleClient, refreshToken: String): GoogleAccessGrant {
        val response = http.post(
            "https://oauth2.googleapis.com/token",
            mapOf(
                "client_id" to client.id,
                "client_secret" to client.secret,
                "refresh_token" to refreshToken,
                "grant_type" to "refresh_token",
            ),
        )
        if (response.status == 400 && GoogleAuthDiagnostics.oauthCode(response.body) == "invalid_grant") {
            throw GoogleReauthorizationRequired()
        }
        return grant(success(response, GoogleAuthStage.TokenRefresh))
    }

    fun revoke(token: String) {
        http.post("https://oauth2.googleapis.com/revoke", mapOf("token" to token))
    }

    fun subscriptions(token: String, page: String? = null, order: String = "alphabetical"): GooglePage<GoogleEntry> {
        require(order == "alphabetical" || order == "unread")
        val json = list(token, "subscriptions", mapOf("part" to "snippet", "mine" to "true", "order" to order), page)
        val rows = json.getJSONArray("items")
        val entries = (0 until rows.length()).mapNotNull { index ->
            val snippet = rows.optJSONObject(index)?.optJSONObject("snippet") ?: return@mapNotNull null
            val id = snippet.optJSONObject("resourceId")?.optString("channelId") ?: return@mapNotNull null
            if (!validId(id)) return@mapNotNull null
            GoogleEntry(id, snippet.optString("title").take(160))
        }
        return GooglePage(entries, nextPage(json))
    }

    fun playlists(token: String, page: String? = null): GooglePage<GoogleEntry> {
        val json = list(token, "playlists", mapOf("part" to "snippet", "mine" to "true"), page)
        val rows = json.getJSONArray("items")
        val entries = (0 until rows.length()).mapNotNull { index ->
            val item = rows.optJSONObject(index) ?: return@mapNotNull null
            val id = item.optString("id")
            if (!validId(id)) return@mapNotNull null
            GoogleEntry(id, item.optJSONObject("snippet")?.optString("title")?.take(160) ?: id)
        }
        return GooglePage(entries, nextPage(json))
    }

    fun uploads(token: String, channelId: String, page: String? = null): GooglePage<VideoSummary> {
        require(validId(channelId))
        val json = list(token, "channels", mapOf("part" to "contentDetails", "id" to channelId), null)
        val items = json.getJSONArray("items")
        val uploadsId = items.optJSONObject(0)?.optJSONObject("contentDetails")
            ?.optJSONObject("relatedPlaylists")?.optString("uploads")?.takeIf { validId(it) }
            ?: return GooglePage(emptyList(), null)
        return playlistItems(token, uploadsId, page)
    }

    fun uploadPlaylists(token: String, channelIds: List<String>): Map<String, String> {
        require(channelIds.size in 1..50 && channelIds.all { validId(it) })
        val json = list(token, "channels", mapOf("part" to "contentDetails", "id" to channelIds.joinToString(",")), null)
        val items = json.getJSONArray("items")
        val requested = channelIds.toHashSet()
        val result = LinkedHashMap<String, String>()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val channelId = item.optString("id")
            val uploads = item.optJSONObject("contentDetails")?.optJSONObject("relatedPlaylists")
                ?.optString("uploads") ?: continue
            if (channelId in requested && validId(uploads)) result[channelId] = uploads
        }
        return result
    }

    fun recentUploads(token: String, uploadsPlaylistId: String, maxResults: Int = 4): List<GoogleDatedVideo> {
        require(validId(uploadsPlaylistId))
        val json = list(
            token, "playlistItems",
            mapOf("part" to "snippet,contentDetails", "playlistId" to uploadsPlaylistId),
            null, maxResults.coerceIn(1, 8),
        )
        return parseVideos(json)
    }

    fun playlistItems(token: String, playlistId: String, page: String? = null): GooglePage<VideoSummary> {
        require(validId(playlistId))
        val json = list(
            token, "playlistItems",
            mapOf("part" to "snippet,contentDetails", "playlistId" to playlistId), page,
        )
        return GooglePage(parseVideos(json).map { it.video }, nextPage(json))
    }

    private fun parseVideos(json: JSONObject): List<GoogleDatedVideo> {
        val items = json.getJSONArray("items")
        return (0 until items.length()).mapNotNull { index ->
            val item = items.optJSONObject(index) ?: return@mapNotNull null
            val snippet = item.optJSONObject("snippet") ?: return@mapNotNull null
            val details = item.optJSONObject("contentDetails")
            val id = details?.optString("videoId")
                ?: snippet.optJSONObject("resourceId")?.optString("videoId")
                ?: return@mapNotNull null
            if (!YouTubeIds.isValid(id) || snippet.optString("title") == "Deleted video" ||
                snippet.optString("title") == "Private video") return@mapNotNull null
            val video = VideoSummary(
                id = id,
                title = snippet.optString("title", id).take(200),
                channel = snippet.optString("videoOwnerChannelTitle", snippet.optString("channelTitle")).take(120),
                durationSeconds = 0,
                viewCount = -1,
                thumbnailUrl = YouTubeIds.thumbnail(id),
                live = false,
                channelUrl = snippet.optString("videoOwnerChannelId")
                    .takeIf { it.matches(Regex("UC[A-Za-z0-9_-]{22}")) }
                    ?.let { "https://www.youtube.com/channel/$it" },
            )
            GoogleDatedVideo(video, details?.optString("videoPublishedAt")?.take(40)
                ?.takeIf { it.isNotBlank() } ?: snippet.optString("publishedAt").take(40))
        }
    }

    private fun list(
        token: String,
        resource: String,
        params: Map<String, String>,
        page: String?,
        maxResults: Int = 50,
    ): JSONObject {
        val args = LinkedHashMap(params)
        args["maxResults"] = maxResults.coerceIn(1, 50).toString()
        if (page != null) args["pageToken"] = page.take(256)
        val query = args.entries.joinToString("&") {
            URLEncoder.encode(it.key, "UTF-8") + "=" + URLEncoder.encode(it.value, "UTF-8")
        }
        return success(http.get("https://www.googleapis.com/youtube/v3/" + resource + "?" + query, token), GoogleAuthStage.AccountBrowse)
    }

    private fun nextPage(json: JSONObject): String? =
        json.optString("nextPageToken").takeIf { it.isNotBlank() && it.length <= 256 }

    private fun grant(json: JSONObject): GoogleAccessGrant {
        val token = json.getString("access_token")
        if (token.isBlank() || !json.optString("token_type", "Bearer").equals("Bearer", true)) {
            throw IOException("Invalid Google token response")
        }
        val scope = json.optString("scope")
        if (scope.isNotEmpty() && YOUTUBE_READONLY !in scope.split(' ')) {
            throw IOException("YouTube read-only scope not granted")
        }
        return GoogleAccessGrant(token, json.optString("refresh_token").takeIf { it.isNotBlank() },
            json.optInt("expires_in", 3600).coerceIn(60, 86400))
    }

    private fun success(response: GoogleHttpResponse, stage: GoogleAuthStage): JSONObject {
        if (stage == GoogleAuthStage.AccountBrowse && response.status == 401) {
            throw GoogleReauthorizationRequired()
        }
        if (response.status !in 200..299) {
            throw GoogleOAuthHttpFailure(stage, response.status, GoogleAuthDiagnostics.oauthCode(response.body))
        }
        return try {
            JSONObject(response.body)
        } catch (_: org.json.JSONException) {
            throw GoogleResponseFormatFailure()
        }
    }

    private fun validId(value: String): Boolean = value.matches(Regex("[A-Za-z0-9_-]{1,100}"))

    companion object {
        const val YOUTUBE_READONLY = "https://www.googleapis.com/auth/youtube.readonly"
    }
}

internal class GoogleReauthorizationRequired : IOException("Sign in to Google again")
