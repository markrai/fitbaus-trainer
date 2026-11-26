package com.fitbaus.bikebridge.host.books

internal data class SummaryProviderPresentation(
    val activeTitle: String,
    val activeDetail: String,
    val candidateTitle: String,
    val candidateDetail: String,
    val reuseTrust: Boolean,
    val showLoboVerification: Boolean,
    val discoveryLabel: String,
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
        state.discovery != null -> if (state.choice == SummaryProviderChoice.LOBO)
            "HTTPS connection established · testing inference" else "Models discovered · test inference before saving"
        state.usesStoredLoboTrust -> "Stored certificate trust · model discovery required"
        state.verifyLoboAgain -> "Verify the replacement certificate before discovery"
        state.choice == SummaryProviderChoice.LOBO && state.addressEntered && !state.authorized -> "Unlock changes to check remembered trust"
        state.canUseLoboTofu -> "First-use trust available · trusted LAN only"
        state.choice == SummaryProviderChoice.LOBO && state.addressEntered -> "Device identity must be verified"
        else -> "Not saved"
    }
    val verify = state.authorized && state.choice == SummaryProviderChoice.LOBO && state.addressEntered &&
        !state.usesStoredLoboTrust && !state.canUseLoboTofu && state.discovery == null
    val label = when {
        verify -> "VERIFY & DISCOVER MODELS"
        state.discovery != null -> "DISCOVER AGAIN"
        state.canUseLoboTofu -> "CONNECT TO LOBO"
        state.choice == SummaryProviderChoice.REUSE -> "DISCOVER CURRENT MODELS"
        else -> "DISCOVER MODELS"
    }
    return SummaryProviderPresentation(activeTitle, activeDetail, candidateTitle, candidateDetail,
        state.usesStoredLoboTrust, verify, label)
}
