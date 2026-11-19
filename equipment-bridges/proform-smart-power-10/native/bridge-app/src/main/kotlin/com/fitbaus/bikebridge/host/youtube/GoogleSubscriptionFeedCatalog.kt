// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import java.io.IOException

internal data class GoogleSubscriptionFeedCursor(
    val remaining: List<GoogleEntry>,
    val nextSubscriptionPage: String?,
) : FeedCursor

internal class GoogleSubscriptionFeedCatalog(
    private val guest: YouTubeCatalog,
    private val store: GoogleAccountStore,
    private val api: GoogleYouTubeApi,
) : YouTubeCatalog {
    private var accessToken: String? = null
    private var accessForRefresh: String? = null
    private var accessForClientId: String? = null
    private var tokenExpiresAtMs = 0L

    override fun discover(): FeedPage {
        if (!store.hasAccount()) {
            clearAccountCache()
            return guest.discover()
        }
        return authenticated {
            val token = authorizedToken()
            val subscriptions = api.subscriptions(token, order = "unread")
            aggregate(token, GoogleSubscriptionFeedCursor(subscriptions.items, subscriptions.next))
        }
    }

    override fun search(query: String): FeedPage = guest.search(query)

    override fun related(seeds: List<VideoSummary>): FeedPage = guest.related(seeds)

    override fun more(cursor: FeedCursor): FeedPage = when (cursor) {
        is GoogleSubscriptionFeedCursor -> authenticated {
            if (!store.hasAccount()) throw YouTubeException(FailureKind.Authentication, "Sign in to Google again")
            aggregate(authorizedToken(), cursor)
        }
        else -> guest.more(cursor)
    }

    override fun resolve(videoId: String): ResolvedVideo = guest.resolve(videoId)

    override fun release() {
        clearAccountCache()
        guest.release()
    }

    private fun aggregate(token: String, original: GoogleSubscriptionFeedCursor): FeedPage {
        var remaining = original.remaining
        var next = original.nextSubscriptionPage
        var checked = 0
        while (checked < MAX_CHANNELS_PER_PAGE && !Thread.currentThread().isInterrupted) {
            if (remaining.isEmpty()) {
                if (next == null) break
                val page = api.subscriptions(token, next, order = "unread")
                remaining = page.items
                next = page.next
                if (remaining.isEmpty() && next == null) break
            }
            val selected = remaining.take(MAX_CHANNELS_PER_PAGE - checked)
            remaining = remaining.drop(selected.size)
            checked += selected.size
            if (selected.isEmpty()) break
            val uploadIds = api.uploadPlaylists(token, selected.map { it.id })
            val all = ArrayList<GoogleDatedVideo>(selected.size * MAX_VIDEOS_PER_CHANNEL)
            var failed = 0
            for (channel in selected) {
                if (Thread.currentThread().isInterrupted) throw IOException("YouTube feed interrupted")
                val uploadsId = uploadIds[channel.id] ?: continue
                try {
                    all.addAll(api.recentUploads(token, uploadsId, MAX_VIDEOS_PER_CHANNEL))
                } catch (e: GoogleReauthorizationRequired) {
                    throw YouTubeException(FailureKind.Authentication, "Google authorization expired", e)
                } catch (e: GoogleOAuthHttpFailure) {
                    if (e.httpStatus == 401 || e.httpStatus == 403 || e.httpStatus == 429) throw e
                    failed += 1
                } catch (_: IOException) {
                    failed += 1
                }
            }
            if (all.isNotEmpty()) {
                val seen = HashSet<String>()
                val sorted = all.sortedWith(compareByDescending<GoogleDatedVideo> { it.publishedAt }
                    .thenBy { it.video.id }).map { it.video }.filter { seen.add(it.id) }
                return FeedPage(sorted, cursor(remaining, next))
            }
            if (failed > 0) throw IOException("Subscribed channel uploads could not be loaded")
        }
        return FeedPage(emptyList(), cursor(remaining, next))
    }

    private fun cursor(remaining: List<GoogleEntry>, next: String?): FeedCursor? =
        if (remaining.isNotEmpty() || next != null) GoogleSubscriptionFeedCursor(remaining, next) else null

    private fun authorizedToken(): String {
        val now = elapsedMs()
        val client = store.client() ?: throw YouTubeException(FailureKind.Authentication, "Google client unavailable")
        val refresh = store.refreshToken()
            ?: throw YouTubeException(FailureKind.Authentication, "Google account authorization unavailable")
        val old = accessToken
        if (old != null && refresh == accessForRefresh && client.id == accessForClientId &&
            now + TOKEN_REFRESH_MARGIN_MS < tokenExpiresAtMs) return old
        val grant = try {
            api.refresh(client, refresh)
        } catch (e: GoogleReauthorizationRequired) {
            clearAccountCache()
            throw YouTubeException(FailureKind.Authentication, "Google authorization expired", e)
        } catch (e: GoogleOAuthHttpFailure) {
            if (e.httpStatus == 401) throw YouTubeException(FailureKind.Authentication, "Google authorization expired", e)
            throw e
        }
        grant.refreshToken?.let { store.saveRefreshToken(it) }
        accessToken = grant.accessToken
        accessForRefresh = grant.refreshToken ?: refresh
        accessForClientId = client.id
        tokenExpiresAtMs = now + grant.expiresInSeconds * 1000L
        return grant.accessToken
    }

    private fun clearAccountCache() {
        accessToken = null
        accessForRefresh = null
        accessForClientId = null
        tokenExpiresAtMs = 0L
    }

    private inline fun <T> authenticated(block: () -> T): T {
        try {
            return block()
        } catch (e: GoogleReauthorizationRequired) {
            clearAccountCache()
            throw YouTubeException(FailureKind.Authentication, "Google authorization expired", e)
        } catch (e: GoogleOAuthHttpFailure) {
            if (e.httpStatus == 401) {
                clearAccountCache()
                throw YouTubeException(FailureKind.Authentication, "Google authorization expired", e)
            }
            if (e.oauthError == "quota_exceeded" || e.oauthError == "rate_limit_exceeded" ||
                e.httpStatus == 429) throw YouTubeException(FailureKind.RateLimited, "YouTube API quota exhausted", e)
            throw e
        }
    }

    private fun elapsedMs(): Long = System.nanoTime() / 1_000_000L

    private companion object {
        const val MAX_CHANNELS_PER_PAGE = 8
        const val MAX_VIDEOS_PER_CHANNEL = 4
        const val TOKEN_REFRESH_MARGIN_MS = 60_000L
    }
}
