package com.fitbaus.bikebridge.host.books

internal class SummaryProviderAction<T>(
    val operation: SummaryProviderOperation,
    val execute: () -> T,
    val complete: (SummaryProviderRequest, T) -> Boolean,
)

internal class SummaryProviderActions(
    private val workflow: SummaryProviderWorkflow,
    private val api: SummaryProviderManagement,
) {
    fun capabilities() = SummaryProviderAction(SummaryProviderOperation.CAPABILITIES, api::capabilities) { ticket, value ->
        workflow.capabilities(ticket, value.first, value.second)
    }

    fun authorize(code: String) = SummaryProviderAction(SummaryProviderOperation.AUTHORIZE, { api.authorize(code) }, workflow::authorized)

    fun discover(url: String, allowHttp: Boolean, key: String, auth: String): SummaryProviderAction<SummaryProviderDiscovery> {
        val state = workflow.state
        val choice = state.choice
        val reuse = choice == SummaryProviderChoice.REUSE ||
            (state.reusesCurrentLobo && state.draftEndpoint == url.trim().trimEnd('/') && auth.isBlank() && key.isEmpty() && !allowHttp)
        val expected = state.authorization
        return SummaryProviderAction(SummaryProviderOperation.DISCOVER, {
            if (reuse) api.discoverCurrent().also { result ->
                require(expected != null && result.candidate.sameEndpointAndTrust(expected))
            } else api.discoverNew(requireNotNull(choice.kind), url, allowHttp, key, auth).also { result ->
                require(result.candidate.baseUrl?.trimEnd('/') == url.trim().trimEnd('/'))
            }
        }, workflow::discovered)
    }

    fun test(): SummaryProviderAction<Long> {
        val model = workflow.state.model.orEmpty()
        return SummaryProviderAction(SummaryProviderOperation.TEST, { api.test(model) }, workflow::tested)
    }

    fun save() = SummaryProviderAction(SummaryProviderOperation.SAVE, api::save, workflow::saved)

    fun disable() = SummaryProviderAction(SummaryProviderOperation.DISABLE, api::disable, workflow::disabled)

    fun cancel() = SummaryProviderAction(SummaryProviderOperation.CANCEL, api::cancel) { ticket, _ ->
        workflow.cancelled(ticket)
    }

    fun begin(action: SummaryProviderAction<*>): SummaryProviderRequest? = workflow.begin(action.operation)

    fun <T> complete(action: SummaryProviderAction<T>, ticket: SummaryProviderRequest, value: T): Boolean {
        if (workflow.state.pending !== ticket || ticket.operation != action.operation) {
            discardClosedCompletion()
            return false
        }
        return action.complete(ticket, value)
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
                SummaryProviderOperation.SAVE, SummaryProviderOperation.DISABLE)) {
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
