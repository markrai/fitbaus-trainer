// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import java.net.URI
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class BooksApiTest {
    private class Http(var response: BooksHttpResponse) : BooksHttp {
        var url = ""
        var token = ""

        override fun get(url: String, token: String): BooksHttpResponse {
            this.url = url
            this.token = token
            return response
        }
    }

    private val server = BooksServer("https://vega.example:9443/audiobookshelf/")

    @Test
    fun librariesUseBearerAuthenticationAndExcludePodcasts() {
        val http = Http(BooksHttpResponse(200, """{"libraries":[
            {"id":"books-1","name":"Audiobooks","mediaType":"book"},
            {"id":"podcasts-1","name":"Podcasts","mediaType":"podcast"}
        ]}"""))
        val api = BooksApi(server, "test-key", http)
        assertEquals(listOf(BooksLibrary("books-1", "Audiobooks")), api.libraries())
        assertEquals("https://vega.example:9443/audiobookshelf/api/libraries", http.url)
        assertEquals("test-key", http.token)
        assertFalse(http.url.contains("test-key"))
    }

    @Test
    fun paginatedItemsSkipUnavailableAndEbookOnlyEntries() {
        val http = Http(BooksHttpResponse(200, """{"total":90,"results":[
            {"id":"book-1","media":{"metadata":{"title":"The Forest","authorName":"Example Author"},"duration":3650.25,"numTracks":3}},
            {"id":"ebook-1","media":{"metadata":{"title":"An ebook"},"numTracks":0}},
            {"id":"missing-1","isMissing":true,"media":{"metadata":{"title":"Missing"},"numTracks":1}}
        ]}"""))
        val page = BooksApi(server, "key", http).items("books-1", 1)
        assertEquals(listOf(BooksItem("book-1", "The Forest", "Example Author", 3650.25, 3)), page.items)
        assertEquals(2, page.nextPage)
        assertEquals("https://vega.example:9443/audiobookshelf/api/libraries/books-1/items?limit=40&page=1&sort=media.metadata.title&minified=1", http.url)
        assertEquals("https://vega.example:9443/audiobookshelf/api/items/book-1/cover?width=256", server.coverUrl("book-1"))
    }

    @Test
    fun lastPageAndEmptyLibraryTerminatePagination() {
        val http = Http(BooksHttpResponse(200, """{"total":0,"results":[]}"""))
        val api = BooksApi(server, "key", http)
        assertEquals(BooksPage(emptyList(), null), api.items("books-1"))
        http.response = BooksHttpResponse(200, """{"total":41,"results":[
            {"id":"book-1","media":{"metadata":{"title":"Book"},"duration":15,"numTracks":1}}
        ]}""")
        assertEquals(null, api.items("books-1", 1).nextPage)
    }

    @Test
    fun invalidServerAndIdsCannotInjectRequestTargets() {
        for (address in listOf(
            "http://vega.example",
            "https://vega.example@other.example",
            "https://vega.example/audiobookshelf?token=x",
            "https://vega.example/#fragment",
            "https://vega.example/../api",
        )) {
            assertThrows(IllegalArgumentException::class.java) { BooksServer(address) }
        }
        assertThrows(IllegalArgumentException::class.java) { server.itemsUrl("../users", 0) }
        assertThrows(IllegalArgumentException::class.java) { server.coverUrl("x?token=y") }
        assertThrows(IllegalArgumentException::class.java) { server.itemsUrl("books", -1) }
        assertThrows(IllegalArgumentException::class.java) { BooksApi(server, "key\r\nInjected: value") }
    }

    @Test
    fun privateIpv4ServersSupportHttpAcrossAllEndpoints() {
        for (host in listOf("10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.193")) {
            val base = "http://$host:13378/audiobookshelf"
            val local = BooksServer(base)
            assertTrue(local.isCleartext)
            assertEquals("$base/login", local.loginUrl())
            assertEquals("$base/auth/refresh", local.refreshUrl())
            assertEquals("$base/api/libraries", local.librariesUrl())
            assertEquals("$base/api/items/book-1/cover?width=256", local.coverUrl("book-1"))
            BooksServer.requireTransport(URI(local.itemsUrl("library", 0)))
            BooksServer.requireTransport(URI(local.searchUrl("library", "title")))
        }
        assertFalse(server.isCleartext)
    }

    @Test
    fun cleartextPublicAndAmbiguousHostsAreRejected() {
        for (host in listOf("example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "192.168.01.1", "192.168.1.1.example.com", "127.0.0.1", "169.254.1.1", "100.64.1.1")) {
            assertThrows(IllegalArgumentException::class.java) { BooksServer("http://$host") }
            assertThrows(IllegalArgumentException::class.java) { BooksServer.requireTransport(URI("http://$host/api/libraries")) }
        }
        assertThrows(IllegalArgumentException::class.java) { BooksServer("http://192.168.1.193@8.8.8.8") }
        assertThrows(IllegalArgumentException::class.java) { BooksServer("http://192.168.1.193?token=x") }
    }

    @Test
    fun searchesServerBookMatchesWithEncodedQueryAndDeduplication() {
        val http = Http(BooksHttpResponse(200, """{"book":[
            {"libraryItem":{"id":"book-1","media":{"metadata":{"title":"A & B","authorName":"Author"},"numTracks":2,"duration":900}}},
            {"libraryItem":{"id":"book-1","media":{"metadata":{"title":"A & B"},"numTracks":2}}},
            {"libraryItem":{"id":"ebook","media":{"metadata":{"title":"Ebook"},"numTracks":0}}}
        ],"authors":[]}"""))
        val results = BooksApi(server, "key", http).search("books-1", "A & B")
        assertEquals(listOf(BooksItem("book-1", "A & B", "Author", 900.0, 2)), results)
        assertEquals("https://vega.example:9443/audiobookshelf/api/libraries/books-1/search?limit=20&q=A+%26+B", http.url)
        assertEquals("key", http.token)
        assertThrows(IllegalArgumentException::class.java) { server.searchUrl("books-1", " ") }
        assertThrows(IllegalArgumentException::class.java) { server.searchUrl("books-1", "a".repeat(201)) }
    }

    @Test
    fun errorsDoNotExposeResponseBodyOrCredentials() {
        val http = Http(BooksHttpResponse(401, """{"error":"secret-key"}"""))
        val failure = assertThrows(BooksHttpFailure::class.java) {
            BooksApi(server, "secret-key", http).libraries()
        }
        assertEquals(401, failure.status)
        assertEquals("Audiobookshelf HTTP 401", failure.message)
        http.response = BooksHttpResponse(302, "")
        assertThrows(BooksHttpFailure::class.java) { BooksApi(server, "secret-key", http).libraries() }
    }
}
