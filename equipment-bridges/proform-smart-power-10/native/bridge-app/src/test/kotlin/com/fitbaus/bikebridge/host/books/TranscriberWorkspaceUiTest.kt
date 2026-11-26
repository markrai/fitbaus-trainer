package com.fitbaus.bikebridge.host.books

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class TranscriberWorkspaceUiTest {
    private fun source(name: String) =
        File("src/main/kotlin/com/fitbaus/bikebridge/host/books/$name.kt").readText()

    @Test
    fun settingsHostsBothManagementViewsInline() {
        val settings = source("TranscriberSettingsPanel")
        assertTrue(settings.contains("selectTab(Tab.Models)"))
        assertTrue(settings.contains("selectTab(Tab.Summarization)"))
        assertTrue(settings.contains("TranscriberManagementDialog(context, connection).also { panel ->"))
        assertTrue(settings.contains("panel.attach(content) { readiness ->"))
        assertTrue(settings.contains("SummaryProviderDialog(context, connection).also { it.attach(content) }"))
        assertFalse(settings.contains("AlertDialog"))
        assertFalse(settings.contains(".show()"))
        assertTrue(settings.contains("connectionForm.visibility = if (value) View.VISIBLE else View.GONE"))
        assertTrue(settings.contains("connectionTitle.text = saved?.address"))
    }

    @Test
    fun inlineViewsAvoidNestedScrollAndCloseTheirOwnWork() {
        val settings = source("TranscriberSettingsPanel")
        val models = source("TranscriberManagementDialog")
        val summary = source("SummaryProviderDialog")
        for (view in listOf(models, summary)) {
            val attach = view.substringAfter("fun attach(parent: LinearLayout").substringBefore("fun close()")
            assertTrue(attach.contains("parent.addView(rows"))
            assertFalse(attach.contains("addView(scroll"))
            assertTrue(view.contains("worker.shutdownNow()"))
        }
        assertTrue(models.contains("main.removeCallbacks(poll)"))
        assertTrue(summary.contains("loboDiscovery.stop()"))
        assertTrue(summary.contains("clearSecrets()"))
        assertTrue(summary.contains("actions.close()"))
        assertTrue(settings.contains("summaryPanel?.close()"))
        assertTrue(settings.contains("modelsPanel?.close()"))
        assertTrue(settings.contains("content.removeAllViews()"))
        assertTrue(models.contains("fun show(): AlertDialog"))
    }
}
