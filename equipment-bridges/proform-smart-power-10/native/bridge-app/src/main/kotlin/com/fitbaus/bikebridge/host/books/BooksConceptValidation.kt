package com.fitbaus.bikebridge.host.books

import org.json.JSONObject

internal object BooksConceptValidation {
    const val MAX_CONCEPTS = 10
    const val MAX_LENGTH = 140
    private val markup = Regex("</?[A-Za-z][^>]*>|&(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);")

    fun parse(result: JSONObject): List<String> {
        require(result.opt("cache_hit") is Boolean && !result.has("graph") && !result.has("mermaid"))
        val values = result.optJSONArray("concepts") ?: error("Invalid concepts")
        require(values.length() in 1..MAX_CONCEPTS)
        val snippets = (0 until values.length()).map { index ->
            val value = values.opt(index) as? String ?: error("Invalid concept")
            require(value == value.trim() && value.codePointCount(0, value.length) in 1..MAX_LENGTH &&
                !markup.containsMatchIn(value))
            var offset = 0
            var meaningful = false
            while (offset < value.length) {
                val cp = value.codePointAt(offset)
                val type = Character.getType(cp)
                require(type !in setOf(Character.CONTROL.toInt(), Character.FORMAT.toInt(),
                    Character.SURROGATE.toInt(), Character.PRIVATE_USE.toInt(),
                    Character.LINE_SEPARATOR.toInt(), Character.PARAGRAPH_SEPARATOR.toInt()))
                if (Character.isLetterOrDigit(cp)) meaningful = true
                offset += Character.charCount(cp)
            }
            require(meaningful)
            value
        }
        require(snippets.distinct().size == snippets.size)
        return snippets
    }
}
