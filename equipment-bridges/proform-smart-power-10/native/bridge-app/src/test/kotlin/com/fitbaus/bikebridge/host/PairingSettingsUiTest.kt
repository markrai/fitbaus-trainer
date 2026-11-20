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
    fun controllerTabCapturesAllDeviceEventsAndScopesMappingsToGames() {
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
        assertTrue(source.contains("ControllerDevices.belongsToController(device)"))
        assertTrue(source.contains("private fun refreshGameMappings()"))
        assertTrue(source.contains("controllerMappingPanel.visibility = if (mode == null) View.GONE else View.VISIBLE"))
        assertTrue(source.contains("gameContext = GameControlCatalog.fromContext(intent.getStringExtra(CONTROLLER_GAME_CONTEXT))"))
        assertTrue(source.contains("gameBindings.assign(mode, selected.descriptor, pending, event.keyCode)"))
        assertTrue(source.contains("return super.dispatchGenericMotionEvent(event)"))
        assertTrue(source.contains("uiHandler.removeCallbacks(controllerPoll)"))
        assertTrue(activity.contains("modeController.mode == ArcadeMode.Bricks"))
        assertTrue(activity.contains("mappedAction = action"))
        assertTrue(activity.contains("if (modeController.mode.isGame) intent.putExtra(CONTROLLER_GAME_CONTEXT, modeController.mode.name)"))
        assertTrue(activity.contains("gameController.handleMotion(event)"))
        assertTrue(activity.contains("val controllerPosition = if (handInput.isTouching() ||"))
        assertTrue(activity.contains("arcadeContent.playground.inputSource != BricksInputSource.Controller"))
        assertTrue(activity.contains(") null else if (exclusiveHid.isActive()) exclusiveHid.sampleBricks(now) else gameController.sample(now)"))
    }

    @Test
    fun exclusiveHidRequiresExplicitPermissionAndHasAReleasePath() {
        val settings = File("src/main/kotlin/com/fitbaus/bikebridge/host/PairingActivity.kt").readText()
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(settings.contains("private fun chooseHidCandidate()"))
        assertTrue(settings.contains("private fun requestExclusiveHid()"))
        assertTrue(settings.contains("private fun releaseExclusiveHid()"))
        assertTrue(settings.contains("manager.requestPermission(device, pi)"))
        assertTrue(settings.contains("manager.hasPermission(device)"))
        assertTrue(settings.contains("device.deviceName != pendingHidName"))
        assertTrue(settings.contains("if (tab != SettingsTab.Controllers) {"))
        assertTrue(settings.contains("exclusiveHid.stop()"))
        assertTrue(settings.contains("exclusiveHid.stop()"))
        assertTrue(settings.contains("beginHidLearn(\"LEFT\")"))
        assertTrue(settings.contains("beginHidLearn(\"RIGHT\")"))
        assertTrue(activity.contains("exclusiveHid.sampleBricks(now)"))
        assertTrue(activity.contains("exclusiveHid.noteAndroidEvent()"))
    }

    @Test
    fun stringsDocumentUnsupportedZoomWithoutFakeFov() {
        val strings = File("src/main/res/values/strings.xml").readText()
        assertTrue(strings.contains("does not expose adjustable zoom"))
        assertTrue(strings.contains("widest view is determined by the camera hardware"))
        assertTrue(strings.contains("settings_tab_webcams\">External Webcams"))
    }
}
