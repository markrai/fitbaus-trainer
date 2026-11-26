package com.fitbaus.bikebridge.host.ui

internal enum class NativeDialogStyle(
    val accent: Int,
    val cornerDp: Int,
    val labelTopDp: Int,
    val labelBottomDp: Int,
    val buttonTextSp: Float?,
    val buttonFill: Int,
    val buttonBorder: Int,
    private val weightedRowButtons: Boolean,
    private val disabledAlpha: Float,
    private val buttonSideDp: Int,
    private val buttonBottomDp: Int,
) {
    SUMMARY_PROVIDER(
        0xffffce1b.toInt(), 8, 8, 4, null, 0xff263341.toInt(),
        0xff455368.toInt(), false, 1f, 0, 4,
    ),
    TRANSCRIPTION_MODELS(
        0xff58d5a5.toInt(), 10, 5, 3, 15f, 0xff2c3b4d.toInt(),
        0xff425166.toInt(), true, 0.45f, 3, 0,
    );

    fun buttonLayout(horizontal: Boolean): DialogButtonLayout {
        val weighted = horizontal && weightedRowButtons
        return DialogButtonLayout(
            width = if (weighted) 0 else -1,
            weight = if (weighted) 1f else 0f,
            heightDp = 48,
            sideDp = buttonSideDp,
            topDp = 6,
            bottomDp = buttonBottomDp,
        )
    }

    fun buttonAlpha(enabled: Boolean, retainOpacity: Boolean): Float =
        if (enabled || retainOpacity) 1f else disabledAlpha
}

internal data class DialogButtonLayout(
    val width: Int,
    val weight: Float,
    val heightDp: Int,
    val sideDp: Int,
    val topDp: Int,
    val bottomDp: Int,
)

internal fun dialogDp(value: Int, density: Float): Int = (value * density + 0.5f).toInt()
