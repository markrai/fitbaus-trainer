package com.fitbaus.bikebridge.host.books

internal enum class SummaryProviderScreen {
    CHECKING, UNSUPPORTED, CONFIGURATION, FINISHED, RELOAD_REQUIRED, CLOSED
}

internal enum class SummaryProviderChoice(val kind: String?) {
    OLLAMA("ollama"), LOBO("lobo"), CUSTOM("custom"), REUSE(null)
}

internal enum class SummaryProviderOperation {
    CAPABILITIES, AUTHORIZE, DISCOVER, TEST, SAVE, DISABLE, CANCEL
}

internal class SummaryProviderRequest(val operation: SummaryProviderOperation)

internal data class SummaryProviderTestResult(val model: String, val elapsedMs: Long)

internal data class SummaryProviderWorkflowState(
    val screen: SummaryProviderScreen = SummaryProviderScreen.CHECKING,
    val activeModel: String? = null,
    val authorization: SummaryProviderStatus? = null,
    val choice: SummaryProviderChoice = SummaryProviderChoice.OLLAMA,
    val addressEntered: Boolean = false,
    val discovery: SummaryProviderDiscovery? = null,
    val model: String? = null,
    val tested: SummaryProviderTestResult? = null,
    val consent: Boolean = false,
    val pending: SummaryProviderRequest? = null,
) {
    val idle: Boolean get() = pending == null
    val editable: Boolean get() = screen == SummaryProviderScreen.CONFIGURATION && idle
    val authorized: Boolean get() = authorization != null
    val canAuthorize: Boolean get() = editable && !authorized
    val canReuse: Boolean get() = editable && authorization?.configured == true
    val canDiscover: Boolean get() = editable && authorized &&
        (choice != SummaryProviderChoice.LOBO || addressEntered)
    val canTest: Boolean get() = editable && authorized && discovery != null
    val canSave: Boolean get() = canTest && tested != null && tested.model == model && consent
    val canDisable: Boolean get() = editable && authorization?.configured == true
    val canCancel: Boolean get() = editable && authorized

    fun withoutTest(): SummaryProviderWorkflowState = copy(tested = null, consent = false)

    fun withoutDiscovery(): SummaryProviderWorkflowState =
        withoutTest().copy(discovery = null, model = null)
}

internal class SummaryProviderWorkflow {
    var state = SummaryProviderWorkflowState()
        private set

    fun choose(choice: SummaryProviderChoice): Boolean {
        if (!state.editable || (choice == SummaryProviderChoice.REUSE && !state.canReuse)) return false
        if (state.choice == choice && choice != SummaryProviderChoice.REUSE) return false
        state = state.withoutDiscovery().copy(
            choice = choice,
            addressEntered = choice == SummaryProviderChoice.REUSE && !state.authorization?.baseUrl.isNullOrBlank(),
        )
        return true
    }

    fun addressEdited(nonBlank: Boolean): Boolean {
        if (!state.editable || state.choice == SummaryProviderChoice.REUSE) return false
        state = state.withoutDiscovery().copy(addressEntered = nonBlank)
        return true
    }

    fun credentialsOrTrustEdited(): Boolean {
        if (!state.editable || state.choice == SummaryProviderChoice.REUSE) return false
        state = state.withoutDiscovery()
        return true
    }

    fun selectModel(value: String?): Boolean {
        val discovery = state.discovery ?: return false
        if (!state.editable || !state.authorized) return false
        val selected = if (discovery.models.isEmpty()) value?.trim() else value
        if (selected != null && discovery.models.isNotEmpty() && selected !in discovery.models) return false
        if (selected == state.model) return false
        state = state.withoutTest().copy(model = selected)
        return true
    }

    fun setConsent(value: Boolean): Boolean {
        if (!state.canTest || state.consent == value) return false
        state = state.copy(consent = value)
        return true
    }

    fun begin(operation: SummaryProviderOperation): SummaryProviderRequest? {
        val allowed = when (operation) {
            SummaryProviderOperation.CAPABILITIES -> state.idle && state.screen != SummaryProviderScreen.CLOSED
            SummaryProviderOperation.AUTHORIZE -> state.canAuthorize
            SummaryProviderOperation.DISCOVER -> state.canDiscover
            SummaryProviderOperation.TEST -> state.canTest
            SummaryProviderOperation.SAVE -> state.canSave
            SummaryProviderOperation.DISABLE -> state.canDisable
            SummaryProviderOperation.CANCEL -> state.canCancel
        }
        if (!allowed) return null
        val request = SummaryProviderRequest(operation)
        state = when (operation) {
            SummaryProviderOperation.CAPABILITIES -> SummaryProviderWorkflowState()
            SummaryProviderOperation.DISCOVER -> state.withoutDiscovery()
            SummaryProviderOperation.TEST -> state.withoutTest()
            else -> state
        }.copy(pending = request)
        return request
    }

    fun capabilities(request: SummaryProviderRequest, supported: Boolean, activeModel: String?): Boolean {
        if (!accepts(request, SummaryProviderOperation.CAPABILITIES)) return false
        state = SummaryProviderWorkflowState(
            screen = if (supported) SummaryProviderScreen.CONFIGURATION else SummaryProviderScreen.UNSUPPORTED,
            activeModel = activeModel,
        )
        return true
    }

    fun authorized(request: SummaryProviderRequest, status: SummaryProviderStatus): Boolean {
        if (!accepts(request, SummaryProviderOperation.AUTHORIZE)) return false
        state = state.copy(authorization = status, activeModel = status.model, pending = null)
        if (state.choice != SummaryProviderChoice.LOBO && !state.addressEntered && status.configured) {
            choose(SummaryProviderChoice.REUSE)
        }
        return true
    }

    fun discovered(request: SummaryProviderRequest, discovery: SummaryProviderDiscovery): Boolean {
        if (!accepts(request, SummaryProviderOperation.DISCOVER)) return false
        val value = discovery.copy(models = discovery.models.toList())
        state = state.withoutTest().copy(
            discovery = value,
            model = value.models.firstOrNull { it == state.activeModel } ?: value.models.firstOrNull(),
            pending = null,
        )
        return true
    }

    fun tested(request: SummaryProviderRequest, elapsedMs: Long): Boolean {
        if (!accepts(request, SummaryProviderOperation.TEST)) return false
        val model = state.model
        val result = if (model != null && SummaryProviderManagement.MODEL.matches(model) && elapsedMs >= 0)
            SummaryProviderTestResult(model, elapsedMs) else null
        state = state.withoutTest().copy(tested = result, pending = null)
        return true
    }

    fun saved(request: SummaryProviderRequest, status: SummaryProviderStatus): Boolean {
        if (!accepts(request, SummaryProviderOperation.SAVE)) return false
        state = if (status.configured && status.model == state.tested?.model) {
            SummaryProviderWorkflowState(SummaryProviderScreen.FINISHED, activeModel = status.model)
        } else {
            SummaryProviderWorkflowState(SummaryProviderScreen.RELOAD_REQUIRED)
        }
        return true
    }

    fun disabled(request: SummaryProviderRequest, status: SummaryProviderStatus): Boolean {
        if (!accepts(request, SummaryProviderOperation.DISABLE)) return false
        state = SummaryProviderWorkflowState(
            if (status.configured) SummaryProviderScreen.RELOAD_REQUIRED else SummaryProviderScreen.FINISHED,
        )
        return true
    }

    fun cancelled(request: SummaryProviderRequest): Boolean {
        if (!accepts(request, SummaryProviderOperation.CANCEL)) return false
        state = SummaryProviderWorkflowState()
        return true
    }

    fun failed(request: SummaryProviderRequest, authorizationLost: Boolean = false): Boolean {
        if (state.pending !== request) return false
        state = if (authorizationLost || request.operation == SummaryProviderOperation.CANCEL) {
            SummaryProviderWorkflowState(SummaryProviderScreen.CONFIGURATION, activeModel = state.activeModel)
        } else {
            state.copy(pending = null)
        }
        return true
    }

    fun close() {
        state = SummaryProviderWorkflowState(SummaryProviderScreen.CLOSED)
    }

    private fun accepts(request: SummaryProviderRequest, operation: SummaryProviderOperation): Boolean =
        state.pending === request && request.operation == operation
}
