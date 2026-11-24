// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.io.IOException

class BooksAuthTest {
    private val server = BooksServer("https://books.example/audiobookshelf")

    @Test
    fun modernLoginRequestsTokensAndPreservesPassword() {
        val auth = BooksAuth(server, BooksAuthHttp { url, headers, body ->
            assertEquals("https://books.example/audiobookshelf/login", url)
            assertEquals(mapOf("x-return-tokens" to "true"), headers)
            assertEquals("reader", JSONObject(body).getString("username"))
            assertEquals(" secret ", JSONObject(body).getString("password"))
            BooksHttpResponse(200, """{"user":{"accessToken":"access","refreshToken":"refresh","token":"legacy"}}""")
        })
        val credentials = auth.login("reader", " secret ")
        assertEquals("access", credentials.accessToken)
        assertEquals("refresh", credentials.refreshToken)
    }

    @Test
    fun legacyLoginAcceptsSingleToken() {
        val auth = BooksAuth(server, BooksAuthHttp { _, _, _ ->
            BooksHttpResponse(200, """{"user":{"token":"legacy"}}""")
        })
        val credentials = auth.login("reader", "secret")
        assertEquals("legacy", credentials.accessToken)
        assertNull(credentials.refreshToken)
    }

    @Test
    fun incompleteModernLoginDoesNotFallBackToLegacyToken() {
        val auth = BooksAuth(server, BooksAuthHttp { _, _, _ ->
            BooksHttpResponse(200, """{"user":{"accessToken":"access","refreshToken":null,"token":"legacy"}}""")
        })
        assertThrows(IOException::class.java) { auth.login("reader", "secret") }
    }

    @Test
    fun expiredAccessTokenRefreshesPersistsAndRetriesOnce() {
        var refreshes = 0
        val auth = BooksAuth(server, BooksAuthHttp { url, headers, body ->
            refreshes++
            assertEquals("https://books.example/audiobookshelf/auth/refresh", url)
            assertEquals(mapOf("x-refresh-token" to "old-refresh"), headers)
            assertEquals("{}", body)
            BooksHttpResponse(200, """{"user":{"accessToken":"new","refreshToken":"new-refresh"}}""")
        })
        val session = BooksSession(BooksCredentials("old", "old-refresh"), auth)
        val persisted = mutableListOf<String>()
        session.onRefresh { persisted.add(it.refreshToken.orEmpty()) }
        val calls = mutableListOf<String>()
        val api = BooksApi(server, session, BooksHttp { _, token ->
            calls.add(token)
            if (token == "old") BooksHttpResponse(401, "") else BooksHttpResponse(200, """{"libraries":[]}""")
        })
        assertEquals(emptyList<BooksLibrary>(), api.libraries())
        assertEquals(emptyList<BooksLibrary>(), api.libraries())
        assertEquals(listOf("old", "new", "new"), calls)
        assertEquals(1, refreshes)
        assertEquals(listOf("new-refresh"), persisted)
    }

    @Test
    fun apiKeysAndForbiddenResponsesDoNotRefresh() {
        val auth = BooksAuth(server, BooksAuthHttp { _, _, _ -> error("Unexpected refresh") })
        val key = BooksSession(BooksCredentials("key"), auth)
        assertEquals(401, assertThrows(BooksHttpFailure::class.java) {
            key.authorized<String> { throw BooksHttpFailure(401) }
        }.status)
        val modern = BooksSession(BooksCredentials("access", "refresh"), auth)
        assertEquals(403, assertThrows(BooksHttpFailure::class.java) {
            modern.authorized<String> { throw BooksHttpFailure(403) }
        }.status)
    }

    @Test
    fun secondUnauthorizedResponseIsNotRetried() {
        var refreshes = 0
        var requests = 0
        val auth = BooksAuth(server, BooksAuthHttp { _, _, _ ->
            refreshes++
            BooksHttpResponse(200, """{"user":{"accessToken":"new","refreshToken":"new-refresh"}}""")
        })
        val session = BooksSession(BooksCredentials("old", "old-refresh"), auth)
        assertThrows(BooksHttpFailure::class.java) {
            session.authorized<String> {
                requests++
                throw BooksHttpFailure(401)
            }
        }
        assertEquals(1, refreshes)
        assertEquals(2, requests)
    }
}
