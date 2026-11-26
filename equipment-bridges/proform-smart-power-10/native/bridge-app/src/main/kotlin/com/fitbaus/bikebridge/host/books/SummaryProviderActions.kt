package com.fitbaus.bikebridge.host.books

internal class SummaryProviderAction<T>(
    val operation: SummaryProviderOperation,
    val execute: () -> T,
    val complete: (SummaryProviderRequest, T) -> Boolean,
    val expectedState: SummaryProviderWorkflowState,
)

internal class SummaryProviderActions(
    private val workflow: SummaryProviderWorkflow,
    private val api: SummaryProviderManagement,
) {
    fun capabilities() = SummaryProviderAction(SummaryProviderOperation.CAPABILITIES, api::capabilities, { ticket, value ->
        workflow.capabilities(ticket, value.first, value.second)
    }, workflow.state)

    fun authorize(code: String) = SummaryProviderAction(SummaryProviderOperation.AUTHORIZE, { api.authorize(code) }, workflow::authorized, workflow.state)

    fun discover(url: String, allowHttp: Boolean, key: String, auth: String,
                 tofu: Boolean = false): SummaryProviderAction<SummaryProviderDiscovery> {
        val state = workflow.state
        val choice = state.choice
        val reuse = choice == SummaryProviderChoice.REUSE ||
            (state.reusesCurrentLobo && state.draftEndpoint == url.trim().trimEnd('/') && auth.isBlank() && key.isEmpty() && !allowHttp)
        val remembered = state.reusesRememberedLobo && state.draftEndpoint == url.trim().trimEnd('/') &&
            auth.isBlank() && key.isEmpty() && !allowHttp
        val expected = state.authorization
        val normalizedUrl = url.trim().trimEnd('/')
        return SummaryProviderAction(SummaryProviderOperation.DISCOVER, {
            if (choice == SummaryProviderChoice.LOBO) require(state.draftEndpoint == normalizedUrl &&
                SummaryProviderManagement.canonicalLoboEndpoint(normalizedUrl) == normalizedUrl)
            if (tofu) {
                require(state.canUseLoboTofu && !allowHttp && key.isEmpty() && auth.isBlank())
                api.discoverFirstUseLobo(normalizedUrl).also { result ->
                    require(result.candidate.matchesTrustedLobo(normalizedUrl))
                }
            } else if (reuse) api.discoverCurrent().also { result ->
                require(expected != null && result.candidate.sameEndpointAndTrust(expected))
            } else if (remembered) api.discoverRememberedLobo(url).also { result ->
                require(result.candidate.matchesTrustedLobo(url))
            } else api.discoverNew(requireNotNull(choice.kind), url, allowHttp, key, auth).also { result ->
                require(result.candidate.baseUrl?.trimEnd('/') == normalizedUrl)
                if (choice == SummaryProviderChoice.LOBO) require(result.candidate.matchesTrustedLobo(normalizedUrl))
            }
        }, workflow::discovered, state)
    }

    fun test(): SummaryProviderAction<Long> {
        val state = workflow.state
        val model = state.model.orEmpty()
        return SummaryProviderAction(SummaryProviderOperation.TEST, { api.test(model) }, workflow::tested, state)
    }

    fun save() = SummaryProviderAction(SummaryProviderOperation.SAVE, api::save, workflow::saved, workflow.state)

    fun disable() = SummaryProviderAction(SummaryProviderOperation.DISABLE, api::disable, workflow::disabled, workflow.state)

    fun forgetLobo(): SummaryProviderAction<SummaryProviderStatus> {
        val state = workflow.state
        val endpoint = state.draftEndpoint.orEmpty()
        return SummaryProviderAction(SummaryProviderOperation.FORGET_LOBO, { api.forgetLobo(endpoint) }, workflow::forgotten, state)
    }

    fun cancel() = SummaryProviderAction(SummaryProviderOperation.CANCEL, api::cancel, { ticket, _ ->
        workflow.cancelled(ticket)
    }, workflow.state)

    fun begin(action: SummaryProviderAction<*>): SummaryProviderRequest? {
        if (action.expectedState !== workflow.state) return null
        return workflow.begin(action.operation)
    }

    fun <T> complete(action: SummaryProviderAction<T>, ticket: SummaryProviderRequest, value: T): Boolean {
        if (workflow.state.pending !== ticket || ticket.operation != action.operation) {
            discardClosedCompletion()
            return false
        }
        val accepted = action.complete(ticket, value)
        if (accepted && workflow.state.screen == SummaryProviderScreen.RELOAD_REQUIRED) api.forgetGrant()
        return accepted
    }

    fun authorizationLost(error: Throwable): Boolean =
        error is SummaryManagementFailure && error.code in setOf("summary_admin_unavailable", "unauthorized")

    fun fail(ticket: SummaryProviderRequest, error: Throwable): Boolean {
        val lost = authorizationLost(error)
        if (!workflow.failed(ticket, lost)) {
            discardClosedCompletion()
            return false
        }
        if (lost || ticket.operation in setOf(SummaryProviderOperation.CANCEL, SummaryProviderOperation.AUTHORIZE,
                SummaryProviderOperation.SAVE, SummaryProviderOperation.DISABLE, SummaryProviderOperation.FORGET_LOBO)) {
            api.forgetGrant()
        }
        return true
    }

    fun close() {
        workflow.close()
        api.forgetGrant()
    }

    fun discardClosedCompletion() {
        if (workflow.state.screen == SummaryProviderScreen.CLOSED) api.forgetGrant()
    }
}
