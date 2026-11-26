package com.fitbaus.bikebridge.host.books

internal object BooksIdentifier {
    fun isValid(value: String): Boolean =
        value.length in 1..128 && value.all { it in 'A'..'Z' || it in 'a'..'z' ||
            it in '0'..'9' || it == '_' || it == '-' }
}

internal class BooksNarrationBinding(
    private val create: (String, String) -> BooksTranscriptRequest = ::BooksTranscriptRequest,
) {
    private var address: String? = null
    private var itemId: String? = null
    private var request: BooksTranscriptRequest? = null

    fun render(serverAddress: String, id: String, open: (BooksTranscriptRequest) -> Unit,
               update: () -> Unit, unavailable: (Exception) -> Unit): Boolean {
        val changed = address != serverAddress || itemId != id
        if (changed) {
            address = serverAddress
            itemId = id
            request = null
        }
        if (!changed && request == null) return false
        return try {
            if (changed) {
                val next = create(serverAddress, id)
                request = next
                open(next)
            } else {
                update()
            }
            true
        } catch (error: Exception) {
            request = null
            unavailable(error)
            false
        }
    }

    fun clear(): Boolean {
        val hadIdentity = address != null
        address = null
        itemId = null
        request = null
        return hadIdentity
    }
}
