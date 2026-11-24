package com.fitbaus.bikebridge.host.books

import org.json.JSONObject
import java.io.InterruptedIOException
import kotlin.math.abs

internal data class PreparationModel(
    val id: String,
    val installed: Boolean,
    val state: String,
    val received: Long,
    val total: Long,
    val qualification: String,
    val memoryAllowed: Boolean,
    val automaticState: String = "idle",
    val completedRuns: Int = 0,
    val totalRuns: Int = 2,
    val qualificationError: String? = null,
) {
    val downloading get() = state == "downloading" || state == "verifying"
    val qualified get() = id == "tiny" || qualification in setOf("live_candidate", "background_candidate")
    val qualifying get() = automaticState in setOf("queued", "running", "waiting_resources")
}

internal data class PreparationJob(
    val id: String,
    val model: String,
    val state: String,
    val processed: Long,
    val total: Long,
    val currentRevision: Boolean,
    val error: String?,
) {
    val running get() = state in setOf("queued", "processing", "waiting_resources")
    val canResume get() = currentRevision && state in setOf("paused", "failed", "waiting_credentials")
    val canDiscard get() = state in setOf("paused", "failed", "cancelled", "completed")
}

internal data class PreparationSnapshot(
    val models: List<PreparationModel>,
    val jobs: List<PreparationJob>,
    val canManageModels: Boolean,
    val canPrepare: Boolean,
    val renewable: Boolean,
    val sourceMatches: Boolean,
    val automaticQualification: Boolean = false,
)

internal class TranscriberManagement(
    private val transcriber: TranscriberConnection,
    private val books: BooksConnection? = null,
    private val item: BooksItem? = null,
    private val playback: BooksPlaybackSession? = null,
    private val http: TranscriberHttp = TranscriberHttp { url, headers, body ->
        val client = BooksUrlConnectionHttp()
        if (body == null) client.getWithHeaders(url, headers) else client.post(url, headers, body)
    },
) {
    init {
        require((books == null) == (item == null))
        require(books == null || books.server.isCleartext || !transcriber.address.startsWith("http://", true))
        require(item == null || item.id.matches(Regex("[A-Za-z0-9_-]{1,128}")))
    }

    private fun call(path: String, body: JSONObject? = null, token: String? = null): JSONObject {
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Request cancelled")
        val headers = mutableMapOf("Authorization" to "Bearer ${transcriber.token}")
        token?.let { headers["X-Audiobookshelf-Token"] = it }
        val response = http.request(transcriber.address + path, headers, body?.toString())
        if (response.status == 401 && token != null) {
            val current = try { capabilities() } catch (error: BooksHttpFailure) {
                throw java.io.IOException("Transcriber connection rejected", error)
            }
            if (!sourceMatches(current)) throw IllegalArgumentException("Audiobookshelf source changed")
        }
        if (response.status !in 200..299) throw BooksHttpFailure(response.status)
        return JSONObject(response.body)
    }

    private fun capabilities(): JSONObject {
        val value = call("/v1/capabilities")
        require(value.getInt("api_version") == 1 && value.getBoolean("job_api"))
        return value
    }

    private fun sourceMatches(caps: JSONObject): Boolean =
        books != null && caps.optString("source_url").trimEnd('/') == books.address.trimEnd('/')

    private fun manifest(caps: JSONObject, token: String): JSONObject {
        val book = requireNotNull(item)
        require(sourceMatches(caps))
        val value = call("/v1/items/${book.id}/manifest", token = token)
        require(value.getString("item_id") == book.id && value.getString("source_id") == caps.getString("source_id"))
        require(value.getString("audio_revision").matches(Regex("[0-9a-f]{64}")))
        val duration = value.getLong("duration_ms")
        require(duration in 1..BooksTranscript.MAX_TIME_MS)
        playback?.let { local ->
            require(abs(duration - local.durationMs) <= 1000)
            val tracks = value.getJSONArray("tracks")
            require(tracks.length() == local.tracks.size)
            for (i in local.tracks.indices) {
                val track = tracks.getJSONObject(i)
                require(track.getString("file_id") == local.tracks[i].url.substringAfterLast('/'))
                require(abs(track.getLong("offset_ms") - local.tracks[i].offsetMs) <= 1000)
                require(abs(track.getLong("duration_ms") - local.tracks[i].durationMs) <= 1000)
            }
        }
        return value
    }

    fun snapshot(): PreparationSnapshot {
        val caps = capabilities()
        val manage = caps.optBoolean("paired_model_management")
        val matches = sourceMatches(caps)
        val prepare = matches && caps.optBoolean("background_job_api") && caps.optBoolean("background_job_lifetime_authorization")
        val qualified = if (caps.optBoolean("model_qualification_api")) call("/v1/qualification").getJSONArray("models") else null
        val rows = caps.optJSONArray("models")
        val models = listOf("tiny", "base", "small").mapNotNull { id ->
            val row = (0 until (rows?.length() ?: 0)).mapNotNull { rows?.optJSONObject(it) }.firstOrNull { it.optString("id") == id }
                ?: return@mapNotNull null
            val record = (0 until (qualified?.length() ?: 0)).mapNotNull { qualified?.optJSONObject(it) }
                .firstOrNull { it.optString("id") == id }
            val automatic = record?.optJSONObject("automatic")
            val totalRuns = (automatic?.optInt("total_runs", 2) ?: 2).coerceIn(1, 10)
            PreparationModel(id, row.getBoolean("installed"), row.getString("state"),
                row.optLong("received_bytes", 0).coerceAtLeast(0),
                row.optLong("total_bytes", row.optLong("approximate_bytes", 0)).coerceAtLeast(0),
                record?.optJSONObject("qualification")?.optString("state") ?: "unqualified",
                record?.optJSONObject("admission")?.optBoolean("allowed") ?: false,
                automatic?.optString("state") ?: "idle",
                (automatic?.optInt("completed_runs", 0) ?: 0).coerceIn(0, totalRuns), totalRuns,
                automatic?.optString("error")?.takeIf { it.matches(Regex("[a-z_]{1,80}")) })
        }
        val jobs = if (prepare) requireNotNull(books).session.authorized { token ->
            val current = manifest(caps, token)
            val book = requireNotNull(item)
            val result = call("/v1/items/${book.id}/background", token = token).getJSONArray("jobs")
            require(result.length() <= 32)
            (0 until result.length()).map { i ->
                val row = result.getJSONObject(i)
                require(row.getString("item_id") == book.id && row.getString("source_id") == current.getString("source_id"))
                val id = row.getString("job_id")
                require(id.matches(Regex("[0-9a-f]{64}")))
                val model = row.getString("model")
                require(model in setOf("tiny", "base", "small"))
                val total = row.getLong("total_ms")
                val processed = row.getLong("processed_ms")
                require(total > 0 && processed in 0..total)
                PreparationJob(id, model, row.getString("state"), processed, total,
                    row.getString("audio_revision") == current.getString("audio_revision"),
                    row.optString("error").takeIf { !row.isNull("error") && it.matches(Regex("[a-z_]{1,80}")) })
            }
        } else emptyList()
        return PreparationSnapshot(models, jobs, manage, prepare, caps.optBoolean("paired_background_refresh"), matches,
            caps.optBoolean("automatic_model_qualification"))
    }

    fun download(model: String, cancel: Boolean = false) {
        require(model in setOf("base", "small") && capabilities().optBoolean("paired_model_management"))
        call("/v1/models/$model/${if (cancel) "cancel" else "download"}", JSONObject())
    }

    fun retryQualification(model: String) {
        require(model in setOf("base", "small") && capabilities().optBoolean("automatic_model_qualification"))
        call("/v1/models/$model/qualify", JSONObject())
    }

    fun matches(currentBooks: BooksConnection?, currentTranscriber: TranscriberConnection?): Boolean =
        books === currentBooks && currentTranscriber?.address == transcriber.address &&
            currentTranscriber?.token == transcriber.token

    private fun granted(caps: JSONObject, result: JSONObject): String? {
        if (!caps.optBoolean("background_reauthorize") ||
            books?.session?.credentials()?.refreshToken == null) return null
        if (result.optString("state") !in setOf("queued", "processing", "waiting_resources", "waiting_credentials")) return null
        return result.getString("job_id").also { require(it.matches(Regex("[0-9a-f]{64}"))) }
    }

    fun start(model: String): String? {
        require(model in setOf("tiny", "base", "small"))
        val caps = capabilities()
        require(caps.optBoolean("background_job_lifetime_authorization") && sourceMatches(caps))
        return requireNotNull(books).session.authorized { token ->
            val current = manifest(caps, token)
            val body = JSONObject().put("source_id", current.getString("source_id"))
                .put("item_id", current.getString("item_id")).put("audio_revision", current.getString("audio_revision"))
                .put("model", model).put("start_ms", 0)
            granted(caps, call("/v1/background", body, token))
        }
    }

    fun action(job: PreparationJob, operation: String): String? {
        require(job.id.matches(Regex("[0-9a-f]{64}")) && operation in setOf("resume", "pause", "cancel", "discard"))
        val caps = capabilities()
        require(caps.optBoolean("background_job_lifetime_authorization") && sourceMatches(caps))
        return requireNotNull(books).session.authorized { token ->
            manifest(caps, token)
            val result = call("/v1/background/${job.id}/$operation", JSONObject(), token)
            if (operation == "resume") granted(caps, result) else null
        }
    }

    fun maintain(jobId: String, stillCurrent: () -> Boolean): Boolean {
        require(jobId.matches(Regex("[0-9a-f]{64}")))
        if (!stillCurrent()) return false
        val caps = capabilities()
        if (!caps.optBoolean("background_reauthorize") || !sourceMatches(caps)) return false
        val book = requireNotNull(item)
        return requireNotNull(books).session.authorized { token ->
            if (!stillCurrent()) return@authorized false
            val path = "/v1/background/$jobId"
            val status = call(path, token = token)
            fun validate(value: JSONObject) {
                require(value.getString("job_id") == jobId && value.getString("item_id") == book.id &&
                    value.getString("source_id") == caps.getString("source_id"))
            }
            validate(status)
            val updated = if (status.getString("state") == "waiting_credentials" && stillCurrent()) {
                call("$path/reauthorize", JSONObject(), token).also(::validate)
            } else status
            updated.getString("state") in setOf("queued", "processing", "waiting_resources", "waiting_credentials")
        }
    }
}
