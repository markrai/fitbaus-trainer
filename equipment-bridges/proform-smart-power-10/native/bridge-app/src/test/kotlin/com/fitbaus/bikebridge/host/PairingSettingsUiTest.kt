// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import org.junit.jupiter.api.Assertions.assertFalse
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
        assertTrue(source.contains("SettingsTab.Analytics"))
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
    fun settingsUsesTheDashboardBrightnessOverrideBeforeShowingItsUiAndOnResume() {
        val settings = File("src/main/kotlin/com/fitbaus/bikebridge/host/PairingActivity.kt").readText()
        val dashboard = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        assertTrue(settings.contains("BridgeProcess.brightness(this).percent() ?: return"))
        assertTrue(settings.contains("attrs.screenBrightness = BrightnessLimits.toWindowBrightness(percent)"))
        assertTrue(dashboard.contains("attrs.screenBrightness = BrightnessLimits.toWindowBrightness(percent)"))
        assertTrue(settings.contains("window.attributes = attrs"))
        val create = settings.substringAfter("override fun onCreate(savedInstanceState: Bundle?)")
            .substringBefore("override fun onResume()")
        assertTrue(create.indexOf("applyStoredBrightness()") in 0 until create.indexOf("setContentView(buildUi())"))
        val resume = settings.substringAfter("override fun onResume()")
            .substringBefore("override fun onPause()")
        assertTrue(resume.contains("applyStoredBrightness()"))
    }

    @Test
    fun analyticsTabReadsServiceOwnedPermanentDailyHistoryWithWeekNavigation() {
        val settings = File("src/main/kotlin/com/fitbaus/bikebridge/host/PairingActivity.kt").readText()
        val chart = File("src/main/kotlin/com/fitbaus/bikebridge/host/CyclingAnalyticsPanel.kt").readText()
        val storage = File("src/main/kotlin/com/fitbaus/bikebridge/host/CyclingAnalyticsStore.kt").readText()
        val service = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeService.kt").readText()
        val usb = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeUsbSession.kt").readText()
        assertTrue(settings.contains("showTab(SettingsTab.Analytics)"))
        assertTrue(settings.contains("CyclingAnalyticsPanel(this)"))
        assertTrue(settings.contains("cyclingAnalytics(this).readSnapshot"))
        assertTrue(chart.contains("monday.minusWeeks(1)"))
        assertTrue(chart.contains("monday.plusWeeks(1)"))
        assertTrue(chart.contains("currentMonday()"))
        assertTrue(chart.contains("previous.isEnabled"))
        assertTrue(chart.contains("next.isEnabled"))
        assertTrue(service.contains("onCyclingReading = { rpm, watts ->"))
        assertTrue(usb.contains("onCyclingReading(rpm, watts)"))
        assertTrue(usb.contains("poll.readings[BikeField.WATTS]"))
        assertTrue(usb.contains("onCyclingReading(null, null)"))
        assertTrue(chart.contains("drawBar(watts, maxWatts, wattsColor, 1)"))
        assertTrue(chart.contains("if (watts != null)"))
        assertTrue(chart.contains("week.averageWatts"))
        assertTrue(storage.contains("ALTER TABLE cycling_daily ADD COLUMN power_ms INTEGER NOT NULL DEFAULT 0"))
        assertTrue(storage.contains("ALTER TABLE cycling_daily ADD COLUMN watt_ms INTEGER NOT NULL DEFAULT 0"))
        assertTrue(storage.contains("CREATE TABLE cycling_daily"))
        assertTrue(storage.contains("INSERT OR IGNORE INTO cycling_daily"))
        assertTrue(storage.contains("db.beginTransaction()"))
        assertTrue(storage.contains("worker.schedule({ flushPending() }, 30L, TimeUnit.SECONDS)"))
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
        assertTrue(activity.contains("val frame = BricksInputRouting.resolve("))
        assertTrue(activity.contains("if (source == BricksInputSource.Controller && touch == null)"))
        assertTrue(activity.contains("exclusiveHid.sampleBricks(now)"))
        assertTrue(activity.contains("gameController.sample(now)"))
    }

    @Test
    fun hidOwnershipIsAutomaticWithoutClaimOrReleaseButtons() {
        val settings = File("src/main/kotlin/com/fitbaus/bikebridge/host/PairingActivity.kt").readText()
        val activity = File("src/main/kotlin/com/fitbaus/bikebridge/host/NativeBridgeActivity.kt").readText()
        val ownership = File("src/main/kotlin/com/fitbaus/bikebridge/host/controller/AutoControllerOwnership.kt").readText()
        assertFalse(settings.contains("private fun chooseHidCandidate()"))
        assertFalse(settings.contains("private fun requestExclusiveHid()"))
        assertFalse(settings.contains("private fun releaseExclusiveHid()"))
        assertFalse(settings.contains("choose.text = \"Claim input\""))
        assertFalse(settings.contains("claim.text = \"Claim input\""))
        assertFalse(settings.contains("release.text = \"Release\""))
        assertTrue(settings.contains("USB HID CONTROLLER (AUTOMATIC)"))
        assertTrue(settings.contains("controllerOwnership.onHostResume()"))
        assertTrue(settings.contains("controllerOwnership.onHostPause()"))
        assertTrue(activity.contains("controllerOwnership.onHostResume()"))
        assertTrue(activity.contains("controllerOwnership.onHostPause()"))
        assertTrue(ownership.contains("manager.requestPermission(device, pending)"))
        assertTrue(ownership.contains("manager.hasPermission(device)"))
        assertTrue(ownership.contains("if (name in deniedDevices)"))
        assertTrue(ownership.contains("UsbManager.ACTION_USB_DEVICE_DETACHED"))
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
