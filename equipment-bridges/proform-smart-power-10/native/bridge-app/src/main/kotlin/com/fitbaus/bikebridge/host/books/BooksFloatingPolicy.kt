package com.fitbaus.bikebridge.host.books

internal object BooksFloatingPolicy {
    fun canFloat(state: BooksPlayerState): Boolean =
        state.item != null && state.session != null && !state.failed
}
