package com.fitbaus.bikebridge.host.books

import java.util.Locale

internal enum class ModelCardTone { Neutral, Working, Ready, Attention }

internal data class ModelCardPresentation(
    val title: String,
    val role: String,
    val description: String,
    val status: String,
    val detail: String?,
    val tone: ModelCardTone,
    val progressValue: Long? = null,
    val progressMax: Long = 0,
)

internal fun modelCardPresentation(model: PreparationModel): ModelCardPresentation {
    val (role, description) = when (model.id) {
        "tiny" -> "DEFAULT · FAST" to "Bundled model for on-demand read-along."
        "base" -> "BALANCED" to "More transcription detail with moderate server load."
        else -> "HIGHER QUALITY" to "Highest quality of these models; more server memory."
    }
    val title = model.id.replaceFirstChar { it.uppercase(Locale.US) }
    val size = model.total.takeIf { it > 0 }?.let { modelMegabytes(it) }
    fun card(status: String, tone: ModelCardTone, detail: String? = size,
             progressValue: Long? = null, progressMax: Long = 0) =
        ModelCardPresentation(title, role, description, status, detail, tone, progressValue, progressMax)
    if (model.downloading) {
        val transferred = if (model.total > 0) "${modelMegabytes(model.received)} / ${modelMegabytes(model.total)}"
            else "${modelMegabytes(model.received)} downloaded"
        return card(if (model.state == "verifying") "Verifying download" else "Downloading",
            ModelCardTone.Working, transferred, model.received, if (model.state == "verifying") 0 else model.total)
    }
    if (!model.installed) return when (model.state) {
        "failed" -> card("Download failed", ModelCardTone.Attention)
        "interrupted" -> card("Download interrupted", ModelCardTone.Attention)
        "cancelled" -> card("Download cancelled", ModelCardTone.Neutral)
        else -> card("Not installed", ModelCardTone.Neutral)
    }
    if (!model.qualified) return when (model.automaticState) {
        "queued" -> card("Hardware check queued", ModelCardTone.Working)
        "running" -> card("Checking hardware", ModelCardTone.Working,
            "${model.completedRuns} of ${model.totalRuns} checks", model.completedRuns.toLong(), model.totalRuns.toLong())
        "waiting_resources" -> card("Waiting for memory", ModelCardTone.Working)
        "failed" -> card("Hardware check failed", ModelCardTone.Attention,
            model.qualificationError?.replace('_', ' ') ?: size)
        else -> card("Hardware check required", ModelCardTone.Attention)
    }
    if (!model.memoryAllowed) return card("Installed · waiting for memory", ModelCardTone.Working)
    return card("Ready", ModelCardTone.Ready)
}

internal fun modelMegabytes(bytes: Long): String =
    String.format(Locale.US, "%.0f MB", bytes / 1_000_000.0)

internal fun bookPreparationModels(models: List<PreparationModel>): List<PreparationModel> =
    models.filter { it.installed && it.qualified && !it.downloading }

internal fun bookPreparationSelection(models: List<PreparationModel>, selected: String): String? =
    models.firstOrNull { it.id == selected }?.id ?: models.firstOrNull()?.id

internal fun modelCardsUseColumns(screenWidthDp: Int): Boolean = screenWidthDp >= 720

internal enum class TranscriberReadiness(val message: String, val ready: Boolean) {
    Ready("Last check · read-along ready", true),
    NotReady("Last check · connected, service not ready", false),
    Unknown("Last check · connected, readiness not reported", false),
    Unverified("Paired · unable to verify server", false),
    CheckIncomplete("Paired · model refresh incomplete", false);

    companion object {
        fun fromFlags(transcription: Boolean?, engineReady: Boolean?, sourceConfigured: Boolean?): TranscriberReadiness =
            if (transcription == null || engineReady == null || sourceConfigured == null) Unknown
            else if (transcription && engineReady && sourceConfigured) Ready else NotReady

        fun fromCapabilities(value: TranscriberCapabilities): TranscriberReadiness =
            if (value.ready) Ready else NotReady
    }
}
