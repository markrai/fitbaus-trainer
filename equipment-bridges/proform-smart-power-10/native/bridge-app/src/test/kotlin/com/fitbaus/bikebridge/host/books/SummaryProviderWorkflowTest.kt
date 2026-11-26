package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SummaryProviderWorkflowTest {
    private val disabled = SummaryProviderStatus(false, null, null, false, false, false, false)
    private val configured = SummaryProviderStatus(
        true, "https://192.168.1.200:7869/v1", "lobo-nano", false, true, false, false,
    )
    private val discovered = SummaryProviderDiscovery(listOf("other", "lobo-nano"), configured)

    private fun begin(flow: SummaryProviderWorkflow, operation: SummaryProviderOperation): SummaryProviderRequest =
        requireNotNull(flow.begin(operation))

    private fun configuration(activeModel: String? = null): SummaryProviderWorkflow =
        SummaryProviderWorkflow().also {
            assertTrue(it.capabilities(begin(it, SummaryProviderOperation.CAPABILITIES), true, activeModel))
        }

    private fun authorized(status: SummaryProviderStatus = configured): SummaryProviderWorkflow =
        configuration(status.model).also {
            assertTrue(it.authorized(begin(it, SummaryProviderOperation.AUTHORIZE), status))
        }

    private fun discoveredFlow(): SummaryProviderWorkflow =
        authorized().also {
            assertTrue(it.discovered(begin(it, SummaryProviderOperation.DISCOVER), discovered))
        }

    private fun testedFlow(): SummaryProviderWorkflow =
        discoveredFlow().also {
            assertTrue(it.tested(begin(it, SummaryProviderOperation.TEST), 3200))
            assertTrue(it.setConsent(true))
        }

    @Test
    fun capabilityCheckGatesManagementAndUnsupportedCanRetry() {
        val flow = SummaryProviderWorkflow()
        assertNull(flow.begin(SummaryProviderOperation.AUTHORIZE))
        val check = begin(flow, SummaryProviderOperation.CAPABILITIES)
        assertFalse(flow.state.idle)
        assertNull(flow.begin(SummaryProviderOperation.CAPABILITIES))
        assertTrue(flow.capabilities(check, false, "old-model"))
        assertEquals(SummaryProviderScreen.UNSUPPORTED, flow.state.screen)
        assertFalse(flow.state.canAuthorize)
        assertFalse(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.capabilities(begin(flow, SummaryProviderOperation.CAPABILITIES), true, null))
        assertTrue(flow.state.canAuthorize)
        assertFalse(flow.state.canDiscover)
        assertFalse(flow.state.canSave)
    }

    @Test
    fun authorizationPreservesDraftAndOnlyOffersReuseForConfiguredProvider() {
        val flow = configuration()
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited("https://192.168.1.200:7869/v1"))
        assertFalse(flow.state.canDiscover)
        assertFalse(flow.choose(SummaryProviderChoice.REUSE))
        assertTrue(flow.authorized(begin(flow, SummaryProviderOperation.AUTHORIZE), configured))
        assertEquals(SummaryProviderChoice.LOBO, flow.state.choice)
        assertTrue(flow.state.addressEntered)
        assertTrue(flow.state.canDiscover)
        assertTrue(flow.state.canReuse)
        assertEquals(SummaryProviderChoice.REUSE, authorized().state.choice)
        val empty = authorized(disabled)
        assertEquals(SummaryProviderChoice.OLLAMA, empty.state.choice)
        assertFalse(empty.state.canReuse)
        assertFalse(empty.state.canDisable)
        assertTrue(empty.state.canCancel)
    }

    @Test
    fun loboNeedsAddressAndEditsInvalidateOnlyCandidateNotAuthorization() {
        val flow = testedFlow()
        assertTrue(flow.state.canSave)
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertFalse(flow.state.canDiscover)
        assertNull(flow.state.discovery)
        assertNull(flow.state.tested)
        assertFalse(flow.state.consent)
        assertTrue(flow.addressEdited("https://192.168.1.200:7869/v1"))
        assertTrue(flow.state.canDiscover)
        assertTrue(flow.discovered(begin(flow, SummaryProviderOperation.DISCOVER), discovered))
        assertTrue(flow.tested(begin(flow, SummaryProviderOperation.TEST), 8))
        assertTrue(flow.setConsent(true))
        assertTrue(flow.credentialsOrTrustEdited())
        assertNull(flow.state.discovery)
        assertNull(flow.state.model)
        assertNull(flow.state.tested)
        assertFalse(flow.state.consent)
        assertTrue(flow.state.authorized)
        assertTrue(flow.state.canDiscover)
        assertFalse(flow.state.canSave)
    }

    @Test
    fun rediscoveryAndModelChangesRequireNewTestAndConsent() {
        val flow = testedFlow()
        assertEquals("lobo-nano", flow.state.model)
        assertEquals(SummaryProviderTestResult("lobo-nano", 3200), flow.state.tested)
        assertFalse(flow.selectModel("not-listed"))
        assertTrue(flow.state.canSave)
        assertTrue(flow.selectModel("other"))
        assertNull(flow.state.tested)
        assertFalse(flow.state.consent)
        assertFalse(flow.state.canSave)
        assertTrue(flow.setConsent(true))
        val test = begin(flow, SummaryProviderOperation.TEST)
        assertFalse(flow.state.consent)
        assertTrue(flow.tested(test, 42))
        assertFalse(flow.state.canSave)
        assertTrue(flow.setConsent(true))
        assertTrue(flow.state.canSave)
        val again = begin(flow, SummaryProviderOperation.DISCOVER)
        assertNull(flow.state.discovery)
        assertNull(flow.state.tested)
        assertTrue(flow.discovered(again, discovered))
        assertFalse(flow.state.canSave)
    }

    @Test
    fun manualModelRequiresValidSuccessfulTestAndExplicitConsent() {
        val flow = authorized()
        assertTrue(flow.discovered(begin(flow, SummaryProviderOperation.DISCOVER),
            SummaryProviderDiscovery(emptyList(), configured)))
        assertNull(flow.state.model)
        assertTrue(flow.selectModel("invalid model"))
        assertTrue(flow.tested(begin(flow, SummaryProviderOperation.TEST), 12))
        assertNull(flow.state.tested)
        assertFalse(flow.state.canSave)
        assertTrue(flow.selectModel(" model:latest "))
        assertEquals("model:latest", flow.state.model)
        assertTrue(flow.tested(begin(flow, SummaryProviderOperation.TEST), 12))
        assertFalse(flow.state.canSave)
        assertTrue(flow.setConsent(true))
        assertTrue(flow.state.canSave)
    }

    @Test
    fun inFlightOperationsRejectEditsAndDuplicateRequests() {
        val flow = discoveredFlow()
        val old = flow.state
        val request = begin(flow, SummaryProviderOperation.TEST)
        val pending = flow.state
        assertFalse(flow.choose(SummaryProviderChoice.CUSTOM))
        assertFalse(flow.addressEdited("https://192.168.1.200:7869/v1"))
        assertFalse(flow.credentialsOrTrustEdited())
        assertFalse(flow.selectModel("other"))
        assertFalse(flow.setConsent(true))
        assertNull(flow.begin(SummaryProviderOperation.CAPABILITIES))
        assertNull(flow.begin(SummaryProviderOperation.CANCEL))
        assertFalse(flow.saved(request, configured))
        assertEquals(pending, flow.state)
        assertTrue(flow.tested(request, 14))
        assertEquals(old.model, flow.state.tested?.model)
    }

    @Test
    fun staleCompletionCannotOverwriteNewOperationOrClosedState() {
        val flow = authorized()
        val first = begin(flow, SummaryProviderOperation.DISCOVER)
        assertTrue(flow.failed(first))
        val second = begin(flow, SummaryProviderOperation.DISCOVER)
        val pending = flow.state
        assertFalse(flow.discovered(first, discovered))
        assertFalse(flow.failed(first, authorizationLost = true))
        assertEquals(pending, flow.state)
        assertTrue(flow.discovered(second, discovered))
        val test = begin(flow, SummaryProviderOperation.TEST)
        flow.close()
        val closed = flow.state
        assertFalse(flow.tested(test, 10))
        assertFalse(flow.failed(test, authorizationLost = true))
        assertNull(flow.begin(SummaryProviderOperation.CAPABILITIES))
        assertEquals(closed, flow.state)
        assertEquals(SummaryProviderScreen.CLOSED, flow.state.screen)
    }

    @Test
    fun failedTestAndExpiredGrantNeverLeaveSaveEnabled() {
        val flow = testedFlow()
        val test = begin(flow, SummaryProviderOperation.TEST)
        assertTrue(flow.failed(test))
        assertNull(flow.state.tested)
        assertFalse(flow.state.consent)
        assertFalse(flow.state.canSave)
        assertTrue(flow.state.canTest)
        val retry = begin(flow, SummaryProviderOperation.TEST)
        assertTrue(flow.failed(retry, authorizationLost = true))
        assertFalse(flow.state.authorized)
        assertTrue(flow.state.canAuthorize)
        assertNull(flow.state.discovery)
        assertFalse(flow.state.canSave)
        assertEquals("lobo-nano", flow.state.activeModel)
    }

    @Test
    fun saveConsumesWorkflowAuthorizationAndMismatchRequiresReload() {
        val flow = testedFlow()
        val save = begin(flow, SummaryProviderOperation.SAVE)
        assertFalse(flow.state.canSave)
        assertTrue(flow.saved(save, configured))
        assertEquals(SummaryProviderScreen.FINISHED, flow.state.screen)
        assertEquals("lobo-nano", flow.state.activeModel)
        assertFalse(flow.state.authorized)
        assertFalse(flow.state.canSave)
        val mismatch = testedFlow()
        assertTrue(mismatch.saved(begin(mismatch, SummaryProviderOperation.SAVE),
            configured.copy(model = "unexpected")))
        assertEquals(SummaryProviderScreen.RELOAD_REQUIRED, mismatch.state.screen)
        assertFalse(mismatch.state.authorized)
        assertNotNull(mismatch.begin(SummaryProviderOperation.CAPABILITIES))
    }

    @Test
    fun activeAndDraftHaveIndependentIdentityAndSaveChecksEndpoint() {
        val flow = authorized()
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited("https://192.168.1.201:7869/v1"))
        val replacement = configured.copy(baseUrl = "https://192.168.1.201:7869/v1", model = "other")
        assertTrue(flow.discovered(begin(flow, SummaryProviderOperation.DISCOVER),
            SummaryProviderDiscovery(listOf("lobo-nano", "other"), replacement)))
        assertEquals("lobo-nano", flow.state.activeModel)
        assertEquals(configured, flow.state.activeProvider)
        assertEquals("other", flow.state.model)
        assertEquals("other", summaryProviderPresentation(flow.state).candidateTitle)
        assertTrue(flow.tested(begin(flow, SummaryProviderOperation.TEST), 25))
        assertTrue(flow.setConsent(true))
        assertTrue(flow.saved(begin(flow, SummaryProviderOperation.SAVE), configured.copy(model = "other")))
        assertEquals(SummaryProviderScreen.RELOAD_REQUIRED, flow.state.screen)
    }

    @Test
    fun reuseTrustIsOnlyForExactAuthorizedPrivateEndpoint() {
        val flow = authorized()
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited("https://192.168.1.200:7869/v1/"))
        assertTrue(flow.state.reusesCurrentLobo)
        assertTrue(flow.addressEdited("https://192.168.1.201:7869/v1"))
        assertFalse(flow.state.reusesCurrentLobo)
        assertFalse(configured.copy(customCa = false).matchesTrustedLobo(configured.baseUrl))
        assertFalse(configured.copy(storageError = true).matchesTrustedLobo(configured.baseUrl))
        val public = configured.copy(baseUrl = "https://8.8.8.8:7869/v1")
        assertFalse(public.matchesTrustedLobo(public.baseUrl))
        assertTrue(flow.addressEdited("https://user:secret@192.168.1.200:7869/v1"))
        assertNull(flow.state.draftEndpoint)
        assertFalse(flow.state.canDiscover)
    }

    @Test
    fun rememberedInactiveEndpointReusesTrustAndExplicitReverificationInvalidatesDraft() {
        val inactive = "https://192.168.1.201:7869/v1"
        val flow = authorized(configured.copy(trustedLoboEndpoints = listOf(inactive)))
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited(inactive))
        assertFalse(flow.state.reusesCurrentLobo)
        assertTrue(flow.state.reusesRememberedLobo)
        assertTrue(summaryProviderPresentation(flow.state).reuseTrust)
        val candidate = configured.copy(baseUrl = inactive)
        assertTrue(flow.discovered(begin(flow, SummaryProviderOperation.DISCOVER),
            SummaryProviderDiscovery(listOf("lobo-nano"), candidate)))
        assertTrue(flow.tested(begin(flow, SummaryProviderOperation.TEST), 10))
        assertTrue(flow.setConsent(true))
        assertTrue(flow.state.canSave)
        assertTrue(flow.setVerifyLoboAgain(true))
        assertFalse(flow.state.usesStoredLoboTrust)
        assertTrue(flow.state.hasStoredLoboTrust)
        assertNull(flow.state.discovery)
        assertFalse(flow.state.canSave)
        assertTrue(flow.setVerifyLoboAgain(false))
        assertTrue(flow.state.usesStoredLoboTrust)
        assertTrue(flow.addressEdited("https://192.168.1.202:7869/v1"))
        assertFalse(flow.state.hasStoredLoboTrust)
        assertFalse(flow.setVerifyLoboAgain(true))
    }

    @Test
    fun disabledProviderCanStillRememberADevice() {
        val endpoint = "https://192.168.1.201:7869/v1"
        val flow = authorized(disabled.copy(trustedLoboEndpoints = listOf(endpoint)))
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited(endpoint))
        assertTrue(flow.state.reusesRememberedLobo)
        assertFalse(flow.state.reusesCurrentLobo)
        assertNull(flow.state.activeModel)
    }

    @Test
    fun verificationIsOptionalOnlyWhenFirstUseTrustIsAdvertised() {
        val flow = configuration()
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited("https://192.168.1.202:7869/v1"))
        assertFalse(flow.state.canUseLoboTofu)
        assertTrue(flow.authorized(begin(flow, SummaryProviderOperation.AUTHORIZE), configured.copy(loboTofuSupported = true)))
        assertTrue(flow.state.canUseLoboTofu)
        assertFalse(summaryProviderPresentation(flow.state).showLoboVerification)
        assertTrue(flow.setVerifyLoboAgain(true))
        assertFalse(flow.state.canUseLoboTofu)
        assertTrue(summaryProviderPresentation(flow.state).showLoboVerification)
        assertTrue(flow.setVerifyLoboAgain(false))
        assertTrue(flow.state.canUseLoboTofu)
        assertTrue(flow.addressEdited("https://192.168.1.200:7869/v1"))
        assertFalse(flow.state.canUseLoboTofu)
    }

    @Test
    fun verificationIsOnlyShownAfterUnlockForSelectedUnrememberedDevice() {
        val flow = configuration()
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertFalse(summaryProviderPresentation(flow.state).showLoboVerification)
        assertTrue(flow.addressEdited("https://192.168.1.202:7869/v1"))
        assertFalse(summaryProviderPresentation(flow.state).showLoboVerification)
        assertTrue(flow.authorized(begin(flow, SummaryProviderOperation.AUTHORIZE), configured))
        assertTrue(summaryProviderPresentation(flow.state).showLoboVerification)
        assertEquals("VERIFY & DISCOVER MODELS", summaryProviderPresentation(flow.state).discoveryLabel)
        assertTrue(flow.discovered(begin(flow, SummaryProviderOperation.DISCOVER),
            SummaryProviderDiscovery(listOf("lobo-nano"), configured.copy(baseUrl = "https://192.168.1.202:7869/v1"))))
        assertFalse(summaryProviderPresentation(flow.state).showLoboVerification)
        assertTrue(flow.credentialsOrTrustEdited())
        assertTrue(summaryProviderPresentation(flow.state).showLoboVerification)
        assertFalse(flow.state.canSave)
    }

    @Test
    fun forgettingInactiveDeviceClearsDraftAndPreservesActiveProvider() {
        val inactive = "https://192.168.1.201:7869/v1"
        val active = requireNotNull(configured.baseUrl)
        val status = configured.copy(trustedLoboEndpoints = listOf(active, inactive))
        val flow = authorized(status)
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertTrue(flow.addressEdited(active))
        assertFalse(flow.state.canForgetLobo)
        assertNull(flow.begin(SummaryProviderOperation.FORGET_LOBO))
        assertTrue(flow.addressEdited(inactive))
        assertTrue(flow.discovered(begin(flow, SummaryProviderOperation.DISCOVER),
            SummaryProviderDiscovery(listOf("lobo-nano"), configured.copy(baseUrl = inactive))))
        assertTrue(flow.tested(begin(flow, SummaryProviderOperation.TEST), 10))
        assertTrue(flow.setConsent(true))
        assertTrue(flow.state.canForgetLobo)
        val ticket = begin(flow, SummaryProviderOperation.FORGET_LOBO)
        assertFalse(flow.state.canSave)
        assertFalse(flow.addressEdited(active))
        assertNull(flow.state.discovery)
        assertTrue(flow.forgotten(ticket, status.copy(trustedLoboEndpoints = listOf(active))))
        assertEquals(active, flow.state.activeProvider?.baseUrl)
        assertEquals(inactive, flow.state.draftEndpoint)
        assertFalse(flow.state.hasStoredLoboTrust)
        assertFalse(flow.state.canForgetLobo)
        assertTrue(flow.state.authorized)
        assertTrue(summaryProviderPresentation(flow.state).showLoboVerification)
    }

    @Test
    fun forgetMismatchOrUncertainResultRequiresReload() {
        val inactive = "https://192.168.1.201:7869/v1"
        val status = configured.copy(trustedLoboEndpoints = listOf(inactive))
        fun selected() = authorized(status).also {
            assertTrue(it.choose(SummaryProviderChoice.LOBO))
            assertTrue(it.addressEdited(inactive))
        }
        val flow = selected()
        assertTrue(flow.forgotten(begin(flow, SummaryProviderOperation.FORGET_LOBO), status))
        assertEquals(SummaryProviderScreen.RELOAD_REQUIRED, flow.state.screen)
        val failed = selected()
        assertTrue(failed.failed(begin(failed, SummaryProviderOperation.FORGET_LOBO)))
        assertEquals(SummaryProviderScreen.RELOAD_REQUIRED, failed.state.screen)
        assertFalse(failed.state.authorized)
    }

    @Test
    fun failedSaveRequiresReloadRatherThanClaimingOldProviderIsStillActive() {
        val flow = testedFlow()
        assertTrue(flow.failed(begin(flow, SummaryProviderOperation.SAVE)))
        assertEquals(SummaryProviderScreen.RELOAD_REQUIRED, flow.state.screen)
        assertFalse(flow.state.authorized)
        assertFalse(flow.state.canSave)
        assertEquals("Not verified", summaryProviderPresentation(flow.state).activeTitle)
    }

    @Test
    fun disableAndCancelClearAuthorizationAndCandidate() {
        val flow = testedFlow()
        assertTrue(flow.disabled(begin(flow, SummaryProviderOperation.DISABLE), disabled))
        assertEquals(SummaryProviderScreen.FINISHED, flow.state.screen)
        assertNull(flow.state.activeModel)
        assertFalse(flow.state.authorized)
        val cancelled = testedFlow()
        assertTrue(cancelled.cancelled(begin(cancelled, SummaryProviderOperation.CANCEL)))
        assertEquals(SummaryProviderScreen.CHECKING, cancelled.state.screen)
        assertFalse(cancelled.state.authorized)
        assertNull(cancelled.state.discovery)
        val failedCancel = testedFlow()
        assertTrue(failedCancel.failed(begin(failedCancel, SummaryProviderOperation.CANCEL)))
        assertTrue(failedCancel.state.canAuthorize)
        assertFalse(failedCancel.state.canSave)
    }

    @Test
    fun lanInventoryUpdatesDoNotInvalidateTestOrConsentWithoutExplicitAddressEdit() {
        val flow = authorized()
        val picker = LoboLanPickerState()
        val device = LoboLanDevice("LOBO-17AE84", "192.168.1.200:7869")
        picker.update(listOf(device))
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        assertNotNull(picker.select(device.address))
        assertTrue(flow.addressEdited("https://192.168.1.200:7869/v1"))
        assertTrue(flow.discovered(begin(flow, SummaryProviderOperation.DISCOVER), discovered))
        assertTrue(flow.tested(begin(flow, SummaryProviderOperation.TEST), 300))
        assertTrue(flow.setConsent(true))
        val before = flow.state
        picker.update(emptyList())
        assertEquals(device, picker.selected)
        assertEquals(before, flow.state)
        assertTrue(flow.state.canSave)
        picker.clearSelection()
        assertTrue(flow.addressEdited(""))
        assertFalse(flow.state.canDiscover)
        assertFalse(flow.state.canSave)
    }

    @Test
    fun loboDraftRejectsNoncanonicalOrNonprivateEndpointsBeforeDiscovery() {
        val flow = authorized()
        assertTrue(flow.choose(SummaryProviderChoice.LOBO))
        for (value in listOf("https://8.8.8.8:7869/v1", "https://192.168.1.200:443/v1",
                "http://192.168.1.200:7869/v1", "https://192.168.1.200:7869/extra/v1")) {
            assertTrue(flow.addressEdited(value))
            assertNull(flow.state.draftEndpoint)
            assertFalse(flow.state.canDiscover)
            assertFalse(summaryProviderPresentation(flow.state).showLoboVerification)
        }
        assertTrue(flow.addressEdited("https://192.168.1.200:7869/v1/"))
        assertTrue(flow.state.canDiscover)
        assertTrue(flow.state.reusesCurrentLobo)
    }

}
