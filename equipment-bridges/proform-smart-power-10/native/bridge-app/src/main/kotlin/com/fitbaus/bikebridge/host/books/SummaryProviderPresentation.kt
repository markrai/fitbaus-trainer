package com.fitbaus.bikebridge.host.books

internal data class SummaryProviderPresentation(
    val activeTitle: String,
    val activeDetail: String,
    val candidateTitle: String,
    val candidateDetail: String,
    val reuseTrust: Boolean,
)

internal fun summaryProviderPresentation(state: SummaryProviderWorkflowState): SummaryProviderPresentation {
    val active = state.activeProvider
    val activeTitle = state.activeModel ?: when (state.screen) {
        SummaryProviderScreen.CHECKING, SummaryProviderScreen.RELOAD_REQUIRED -> "Not verified"
        else -> "Disabled or unavailable"
    }
    val activeDetail = active?.baseUrl ?: if (state.activeModel != null)
        "Saved model reported by Transcriber · endpoint available after authorization"
        else "No active model reported"
    val candidateTitle = state.model ?: when {
        state.choice == SummaryProviderChoice.LOBO && state.addressEntered -> "LOBO device selected"
        state.choice == SummaryProviderChoice.REUSE -> "Current provider selected"
        else -> "Choose a provider and model"
    }
    val candidateDetail = when {
        state.tested != null -> "Inference test passed · not saved"
        state.discovery != null -> "Models discovered · test inference before saving"
        state.usesStoredLoboTrust -> "Stored certificate trust · model discovery required"
        state.verifyLoboAgain -> "Verify the replacement certificate before discovery"
        state.choice == SummaryProviderChoice.LOBO && state.addressEntered -> "Device identity must be verified"
        else -> "Not saved"
    }
    return SummaryProviderPresentation(activeTitle, activeDetail, candidateTitle, candidateDetail, state.usesStoredLoboTrust)
}
