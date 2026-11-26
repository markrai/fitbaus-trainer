package com.fitbaus.bikebridge.host.ui

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class NativeDialogStyleTest {
    @Test
    fun summaryButtonsRemainFullWidthWithExistingMargins() {
        val style = NativeDialogStyle.SUMMARY_PROVIDER
        val expected = DialogButtonLayout(-1, 0f, 48, 0, 6, 4)
        assertEquals(expected, style.buttonLayout(horizontal = false))
        assertEquals(expected, style.buttonLayout(horizontal = true))
    }

    @Test
    fun transcriptionButtonsShareHorizontalSpaceButFillVerticalCards() {
        val style = NativeDialogStyle.TRANSCRIPTION_MODELS
        assertEquals(DialogButtonLayout(0, 1f, 48, 3, 6, 0), style.buttonLayout(horizontal = true))
        assertEquals(DialogButtonLayout(-1, 0f, 48, 3, 6, 0), style.buttonLayout(horizontal = false))
    }

    @Test
    fun disabledTranscriptionActionsDimButSelectedModelStaysReadable() {
        val style = NativeDialogStyle.TRANSCRIPTION_MODELS
        assertEquals(1f, style.buttonAlpha(enabled = true, retainOpacity = false))
        assertEquals(0.45f, style.buttonAlpha(enabled = false, retainOpacity = false))
        assertEquals(1f, style.buttonAlpha(enabled = false, retainOpacity = true))
        assertEquals(1f, NativeDialogStyle.SUMMARY_PROVIDER.buttonAlpha(enabled = false, retainOpacity = false))
    }

    @Test
    fun densityConversionPreservesLegacyRoundedPixelSizes() {
        assertEquals(0, dialogDp(0, 1.5f))
        assertEquals(48, dialogDp(48, 1f))
        assertEquals(72, dialogDp(48, 1.5f))
        assertEquals(60, dialogDp(48, 1.25f))
        assertEquals(5, dialogDp(3, 1.5f))
        assertEquals(2, dialogDp(1, 1.5f))
    }
}
