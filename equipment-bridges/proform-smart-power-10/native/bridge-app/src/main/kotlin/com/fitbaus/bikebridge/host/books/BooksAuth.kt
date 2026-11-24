// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import java.io.IOException

internal class BooksCredentials(val accessToken: String, val refreshToken: String? = null) {
    init {
        require(validToken(accessToken))
        require(refreshToken == null || validToken(refreshToken))
    }

    private fun validToken(value: String): Boolean =
        value.length in 1..8192 && value.all { it in '!'..'~' }
}

internal class BooksAuth(
    private val server: BooksServer,
    private val http: BooksAuthHttp = BooksUrlConnectionHttp(),
) {
    fun login(username: String, password: String): BooksCredentials {
        require(username.isNotBlank() && username.length <= 256 && password.length <= 4096)
        val body = JSONObject().put("username", username).put("password", password).toString()
        val user = user(http.post(server.loginUrl(), mapOf("x-return-tokens" to "true"), body))
        if (user.has("accessToken") || user.has("refreshToken")) return modern(user)
        return BooksCredentials(user.getString("token"))
    }

    fun refresh(token: String): BooksCredentials {
        return modern(user(http.post(server.refreshUrl(), mapOf("x-refresh-token" to token), "{}")))
    }

    private fun user(response: BooksHttpResponse): JSONObject {
        if (response.status !in 200..299) throw BooksHttpFailure(response.status)
        return JSONObject(response.body).getJSONObject("user")
    }

    private fun modern(user: JSONObject): BooksCredentials {
        val access = user.optString("accessToken", "")
        val refresh = user.optString("refreshToken", "")
        if (access.isBlank() || refresh.isBlank() || user.isNull("accessToken") || user.isNull("refreshToken")) {
            throw IOException("Incomplete Audiobookshelf login response")
        }
        return BooksCredentials(access, refresh)
    }
}

internal class BooksSession(initial: BooksCredentials, private val auth: BooksAuth) {
    @Volatile private var current = initial
    @Volatile private var persist: ((BooksCredentials) -> Unit)? = null

    fun credentials(): BooksCredentials = current

    fun onRefresh(callback: (BooksCredentials) -> Unit) {
        persist = callback
    }

    fun <T> authorized(action: (String) -> T): T {
        val used = current
        try {
            return action(used.accessToken)
        } catch (error: BooksHttpFailure) {
            if (error.status != 401 || used.refreshToken == null) throw error
        }
        val updated = renew(used)
        return action(updated.accessToken)
    }

    @Synchronized
    private fun renew(used: BooksCredentials): BooksCredentials {
        if (current !== used) return current
        val refresh = used.refreshToken ?: throw BooksHttpFailure(401)
        val updated = auth.refresh(refresh)
        persist?.invoke(updated)
        current = updated
        return updated
    }
}

internal class BooksConnection(val address: String, credentials: BooksCredentials) {
    constructor(address: String, token: String) : this(address, BooksCredentials(token))

    val server = BooksServer(address)
    val session = BooksSession(credentials, BooksAuth(server))
    val api = BooksApi(server, session)
}
