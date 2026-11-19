// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.youtube

import android.os.Handler
import android.os.Looper
import android.os.SystemClock

internal enum class GoogleAccountPhase { SignedOut, Connecting, Authorizing, Connected, Error }

internal data class GoogleAccountStatus(
    val phase: GoogleAccountPhase,
    val message: String = "",
    val verificationUrl: String = "",
    val userCode: String = "",
)

internal object GooglePolling {
    fun interval(seconds: Int, slowDown: Boolean): Int =
        (seconds.coerceIn(5, 120) + if (slowDown) 5 else 0).coerceAtMost(120)
}

internal class GoogleAccountController(
    private val store: GoogleAccountStore,
    private val api: GoogleYouTubeApi,
    private val runner: BackgroundRunner,
    private val main: MainThread,
    private val handler: Handler = Handler(Looper.getMainLooper()),
) {
    var listener: ((GoogleAccountStatus) -> Unit)? = null
    var status = GoogleAccountStatus(GoogleAccountPhase.SignedOut)
        private set

    private var active = false
    private var generation = 0L
    private var feedGeneration = 0L
    private var ticket: GoogleDeviceCode? = null
    private var deadlineMs = 0L
    private var interval = 5
    private var job: Cancellable? = null
    private var feedJob: Cancellable? = null
    private var accessToken: String? = null
    private var accessExpiresAt = 0L
    private val pollRunnable = Runnable { poll() }

    fun hasAccount(): Boolean = store.hasAccount()

    fun start() {
        if (active) return
        active = true
        setStatus(GoogleAccountStatus(if (store.hasAccount()) GoogleAccountPhase.Connected else GoogleAccountPhase.SignedOut))
    }

    fun stop() {
        if (!active) return
        active = false
        generation += 1
        feedGeneration += 1
        handler.removeCallbacks(pollRunnable)
        job?.cancel()
        feedJob?.cancel()
        job = null
        feedJob = null
        ticket = null
        accessToken = null
        accessExpiresAt = 0
    }

    fun destroy() {
        stop()
        listener = null
        runner.shutdown()
    }

    fun signIn(client: GoogleClient, onStored: ((Boolean) -> Unit)? = null) {
        if (!active) {
            onStored?.invoke(false)
            return
        }
        if (!client.id.endsWith(".apps.googleusercontent.com") || client.secret.isBlank() ||
            client.id.length > 256 || client.secret.length > 256) {
            setStatus(GoogleAccountStatus(GoogleAccountPhase.Error, "Enter a TV OAuth client ID and secret."))
            onStored?.invoke(false)
            return
        }
        cancelPending()
        val current = generation
        setStatus(GoogleAccountStatus(GoogleAccountPhase.Connecting, "Requesting authorization from Google…"))
        job = runner.submit {
            val saved = runCatching { store.saveClient(client) }
            main.post { onStored?.invoke(saved.isSuccess) }
            val result = saved.mapCatching { api.requestCode(client) }
            main.post {
                if (!valid(current)) return@post
                result.fold(
                    onSuccess = { code ->
                        ticket = code
                        deadlineMs = SystemClock.elapsedRealtime() + code.expiresInSeconds * 1000L
                        interval = code.intervalSeconds
                        setStatus(GoogleAccountStatus(GoogleAccountPhase.Authorizing,
                            "On your phone, open the URL and enter the code.",
                            code.verificationUrl, code.userCode))
                        handler.postDelayed(pollRunnable, interval * 1000L)
                    },
                    onFailure = { setStatus(GoogleAccountStatus(GoogleAccountPhase.Error, "Unable to start Google sign-in.")) },
                )
            }
        }
    }

    fun cancelAuthorization() {
        if (!active) return
        cancelPending()
        setStatus(GoogleAccountStatus(if (store.hasAccount()) GoogleAccountPhase.Connected else GoogleAccountPhase.SignedOut))
    }

    fun signOut() {
        if (!active) return
        cancelPending()
        feedGeneration += 1
        feedJob?.cancel()
        val old = runCatching { store.refreshToken() }.getOrNull()
        val cleared = runCatching { store.clearRefreshToken() }.isSuccess
        if (!cleared) {
            setStatus(GoogleAccountStatus(GoogleAccountPhase.Error, "Unable to remove saved Google authorization."))
            return
        }
        accessToken = null
        accessExpiresAt = 0
        setStatus(GoogleAccountStatus(GoogleAccountPhase.SignedOut))
        if (!old.isNullOrBlank()) runner.submit { runCatching { api.revoke(old) } }
    }

    fun subscriptions(page: String? = null, done: (Result<GooglePage<GoogleEntry>>) -> Unit) {
        load({ token -> api.subscriptions(token, page) }, done)
    }

    fun playlists(page: String? = null, done: (Result<GooglePage<GoogleEntry>>) -> Unit) {
        load({ token -> api.playlists(token, page) }, done)
    }

    fun uploads(channelId: String, page: String? = null, done: (Result<GooglePage<VideoSummary>>) -> Unit) {
        load({ token -> api.uploads(token, channelId, page) }, done)
    }

    fun playlistItems(playlistId: String, page: String? = null, done: (Result<GooglePage<VideoSummary>>) -> Unit) {
        load({ token -> api.playlistItems(token, playlistId, page) }, done)
    }

    private fun <T> load(fetch: (String) -> GooglePage<T>, done: (Result<GooglePage<T>>) -> Unit) {
        if (!active || status.phase != GoogleAccountPhase.Connected) return
        val requestId = ++feedGeneration
        feedJob?.cancel()
        feedJob = runner.submit {
            val result = runCatching {
                val token = authorizedToken()
                try {
                    fetch(token)
                } catch (_: GoogleReauthorizationRequired) {
                    accessToken = null
                    fetch(authorizedToken())
                }
            }
            main.post {
                if (!active || requestId != feedGeneration) return@post
                if (result.exceptionOrNull() is GoogleReauthorizationRequired) {
                    runner.submit { store.clearRefreshToken() }
                    accessToken = null
                    setStatus(GoogleAccountStatus(GoogleAccountPhase.SignedOut, "Google authorization expired. Sign in again."))
                }
                done(result)
            }
        }
    }

    private fun authorizedToken(): String {
        val now = SystemClock.elapsedRealtime()
        val existing = accessToken
        if (existing != null && now + 60_000L < accessExpiresAt) return existing
        val client = store.client() ?: throw GoogleReauthorizationRequired()
        val refresh = store.refreshToken() ?: throw GoogleReauthorizationRequired()
        val updated = api.refresh(client, refresh)
        updated.refreshToken?.let { store.saveRefreshToken(it) }
        accessToken = updated.accessToken
        accessExpiresAt = now + updated.expiresInSeconds * 1000L
        return updated.accessToken
    }

    private fun poll() {
        val request = ticket ?: return
        if (!active || status.phase != GoogleAccountPhase.Authorizing) return
        if (SystemClock.elapsedRealtime() >= deadlineMs) {
            cancelAuthorization()
            setStatus(GoogleAccountStatus(GoogleAccountPhase.Error, "Google authorization code expired."))
            return
        }
        val current = generation
        job = runner.submit {
            val result = runCatching {
                val client = store.client() ?: throw GoogleReauthorizationRequired()
                val response = api.poll(client, request.code)
                if (response is GooglePollResult.Authorized) {
                    val refresh = response.grant.refreshToken
                        ?: throw GoogleReauthorizationRequired()
                    store.saveRefreshToken(refresh)
                }
                response
            }
            main.post {
                if (!valid(current) || ticket != request) return@post
                result.fold(
                    onSuccess = { response ->
                        when (response) {
                            GooglePollResult.Pending -> handler.postDelayed(pollRunnable, interval * 1000L)
                            GooglePollResult.SlowDown -> {
                                interval = GooglePolling.interval(interval, true)
                                handler.postDelayed(pollRunnable, interval * 1000L)
                            }
                            GooglePollResult.Denied -> {
                                cancelAuthorization()
                                setStatus(GoogleAccountStatus(GoogleAccountPhase.Error, "Google access was denied."))
                            }
                            GooglePollResult.Expired -> {
                                cancelAuthorization()
                                setStatus(GoogleAccountStatus(GoogleAccountPhase.Error, "Google authorization code expired."))
                            }
                            is GooglePollResult.Authorized -> {
                                ticket = null
                                accessToken = response.grant.accessToken
                                accessExpiresAt = SystemClock.elapsedRealtime() + response.grant.expiresInSeconds * 1000L
                                setStatus(GoogleAccountStatus(GoogleAccountPhase.Connected))
                            }
                        }
                    },
                    onFailure = {
                        cancelAuthorization()
                        setStatus(GoogleAccountStatus(GoogleAccountPhase.Error, "Google sign-in failed. Try again."))
                    },
                )
            }
        }
    }

    private fun cancelPending() {
        generation += 1
        handler.removeCallbacks(pollRunnable)
        job?.cancel()
        job = null
        ticket = null
    }

    private fun valid(requestId: Long): Boolean = active && generation == requestId

    private fun setStatus(value: GoogleAccountStatus) {
        status = value
        listener?.invoke(value)
    }
}
