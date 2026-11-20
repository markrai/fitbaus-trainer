// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class PairingSettingsUiTest {
    @Test
    fun settingsExposePairingAndExternalWebcamTabs() {
        val source = File(
            "src/main/kotlin/com/fitbaus/bikebridge/host/PairingActivity.kt",
        ).readText()
        assertTrue(source.contains("SettingsTab.Pairing"))
        assertTrue(source.contains("SettingsTab.Webcams"))
        assertTrue(source.contains("settings_tab_pairing"))
        assertTrue(source.contains("settings_tab_webcams"))
        assertTrue(source.contains("ExternalWebcamPreview"))
        assertTrue(source.contains("UvcZoomPreference.Widest"))
        assertTrue(source.contains("UvcZoomPreference.CameraDefault"))
        assertTrue(source.contains("WebcamZoomStore.save"))
        assertTrue(source.contains("requestSetZoom"))
        assertTrue(source.contains("promptUsbPermission"))
        assertTrue(source.contains("previewMatches"))
        assertTrue(source.contains("detachAffectsOpened"))
        assertTrue(source.contains("webcam_zoom_unverified"))
        assertTrue(source.contains("UvcProcess.acquire"))
        assertTrue(source.contains("UvcProcess.release"))
        assertTrue(source.contains("stopPreview()"))
        assertTrue(source.contains("webcam_zoom_unsupported"))
    }

    @Test
    fun controllerTabListsDevicesCapturesDiagnosticsAndPreservesNavigation() {
        val source = File("src/main/kotlin/com/fitbaus/bikebridge/host/PairingActivity.kt").readText()
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val strings = File("src/main/res/values/strings.xml").readText()
        assertTrue(source.contains("SettingsTab.Controllers"))
        assertTrue(source.contains("settings_tab_controllers"))
        assertTrue(strings.contains("settings_tab_controllers"))
        assertTrue(source.contains("ControllerDevices.visible()"))
        assertTrue(source.contains("ControllerDevices.chosen(devices, selected)"))
        assertTrue(source.contains("private fun chooseController()"))
        assertTrue(source.contains("override fun dispatchKeyEvent(event: KeyEvent)"))
        assertTrue(source.contains("override fun dispatchGenericMotionEvent(event: MotionEvent)"))
        assertTrue(source.contains("return super.dispatchKeyEvent(event)"))
        assertTrue(source.contains("ControllerGameplayKeys.trapsSettingsNavigation(event.keyCode)"))
        assertTrue(source.contains("if (ControllerGameplayKeys.trapsSettingsNavigation(event.keyCode)) return true"))
        assertTrue(source.contains("return super.dispatchGenericMotionEvent(event)"))
        assertTrue(source.contains("uiHandler.removeCallbacks(controllerPoll)"))
        assertTrue(activity.contains("modeController.mode == ArcadeMode.Bricks"))
        assertTrue(activity.contains("gameController.handleKey(event, steerBricks = modeController.mode == ArcadeMode.Bricks)"))
        assertTrue(activity.contains("modeController.isActive && modeController.mode.isGame"))
        assertTrue(activity.contains("gameController.handleMotion(event)"))
        assertTrue(activity.contains("if (handInput.isTouching()) null else gameController.sample(now)"))
    }

    @Test
    fun stringsDocumentUnsupportedZoomWithoutFakeFov() {
        val strings = File("src/main/res/values/strings.xml").readText()
        assertTrue(strings.contains("does not expose adjustable zoom"))
        assertTrue(strings.contains("widest view is determined by the camera hardware"))
        assertTrue(strings.contains("settings_tab_webcams\">External Webcams"))
    }
}
