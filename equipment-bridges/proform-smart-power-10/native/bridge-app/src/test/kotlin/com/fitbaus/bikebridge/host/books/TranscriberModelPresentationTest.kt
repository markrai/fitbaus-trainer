package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TranscriberModelPresentationTest {
    private val base = PreparationModel("base", false, "not_installed", 0, 148000000, "unqualified", false)

    @Test
    fun onlyInstalledQualifiedAndAdmittedModelsAreReady() {
        val installed = base.copy(installed = true, state = "installed", qualification = "background_candidate")
        assertEquals(ModelCardTone.Working, modelCardPresentation(installed).tone)
        val ready = modelCardPresentation(installed.copy(memoryAllowed = true))
        assertEquals(ModelCardTone.Ready, ready.tone)
        assertEquals("148 MB", ready.detail)
        assertEquals(ModelCardTone.Neutral, modelCardPresentation(base).tone)
    }

    @Test
    fun bookSelectionOnlyOffersInstalledQualifiedModelsAndKeepsCurrentChoice() {
        val tiny = base.copy(id = "tiny", installed = true, state = "installed")
        val qualified = base.copy(installed = true, state = "installed", qualification = "background_candidate")
        val unqualified = base.copy(id = "small", installed = true, state = "installed")
        val models = bookPreparationModels(listOf(tiny, base, qualified, unqualified, qualified.copy(state = "downloading")))
        assertEquals(listOf(tiny, qualified), models)
        assertEquals("tiny", bookPreparationSelection(models, "tiny"))
        assertEquals("base", bookPreparationSelection(models, "base"))
        assertEquals("base", bookPreparationSelection(listOf(qualified), "tiny"))
        assertNull(bookPreparationSelection(emptyList(), "tiny"))
    }

    @Test
    fun downloadAndVerificationUseActualReportedBytes() {
        val partial = base.copy(state = "downloading", received = 74000000)
        val progress = modelCardPresentation(partial)
        assertEquals("74 MB / 148 MB", progress.detail)
        assertEquals(74000000L, progress.progressValue)
        assertEquals(148000000L, progress.progressMax)
        assertEquals("Verifying download", modelCardPresentation(partial.copy(state = "verifying")).status)
        assertEquals(0L, modelCardPresentation(partial.copy(state = "verifying")).progressMax)
        assertEquals(0L, modelCardPresentation(partial.copy(total = 0)).progressMax)
        assertNull(modelCardPresentation(base.copy(total = 0)).detail)
    }

    @Test
    fun qualificationAndFailureAreDistinctFromDownload() {
        val checking = base.copy(installed = true, state = "installed", automaticState = "running", completedRuns = 1)
        val progress = modelCardPresentation(checking)
        assertEquals("1 of 2 checks", progress.detail)
        assertEquals(1L, progress.progressValue)
        assertEquals(2L, progress.progressMax)
        assertEquals(ModelCardTone.Attention, modelCardPresentation(checking.copy(automaticState = "failed")).tone)
        assertEquals("Download interrupted", modelCardPresentation(base.copy(state = "interrupted")).status)
        assertEquals("Download failed", modelCardPresentation(base.copy(state = "failed")).status)
    }

    @Test
    fun landscapeUsesColumnsAndNarrowLayoutsStack() {
        assertFalse(modelCardsUseColumns(719))
        assertTrue(modelCardsUseColumns(720))
        assertTrue(modelCardsUseColumns(1024))
    }

    @Test
    fun readinessNeverTreatsMissingFlagsAsReady() {
        assertEquals(TranscriberReadiness.Unknown, TranscriberReadiness.fromFlags(true, null, true))
        assertEquals(TranscriberReadiness.NotReady, TranscriberReadiness.fromFlags(true, true, false))
        assertEquals(TranscriberReadiness.Ready, TranscriberReadiness.fromFlags(true, true, true))
        assertFalse(TranscriberReadiness.CheckIncomplete.ready)
    }
}
