// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import com.fitbaus.arcade.ExternalWebcamPreview
import com.fitbaus.arcade.UvcZoomCapability
import com.fitbaus.arcade.UvcZoomPreference
import com.fitbaus.bikebridge.host.controller.ControllerDevices
import com.fitbaus.bikebridge.host.uvc.UvcCameraHost
import com.fitbaus.bikebridge.host.uvc.UvcDeviceInfo
import com.fitbaus.bikebridge.host.uvc.UvcDeviceSelector
import com.fitbaus.bikebridge.host.uvc.UvcProcess
import com.fitbaus.bikebridge.host.uvc.WebcamZoomStore
import com.fitbaus.bikebridge.protocol.BridgeHttpJson
import com.fitbaus.bikebridge.protocol.BridgeHttpRouter
import com.fitbaus.bikebridge.protocol.PairingToken
import java.util.concurrent.atomic.AtomicInteger

class PairingActivity : Activity() {
    private enum class SettingsTab { Pairing, Webcams, Controllers }

    private val uiHandler = Handler(Looper.getMainLooper())
    private lateinit var endpointValue: TextView
    private lateinit var tokenValue: TextView
    private lateinit var pairingPanel: View
    private lateinit var webcamPanel: View
    private lateinit var controllerPanel: View
    private lateinit var pairingTab: TextView
    private lateinit var webcamTab: TextView
    private lateinit var controllerTab: TextView
    private lateinit var controllerList: TextView
    private lateinit var controllerSelection: TextView
    private lateinit var controllerEvents: TextView
    private lateinit var cameraList: TextView
    private lateinit var statusText: TextView
    private lateinit var zoomStatus: TextView
    private lateinit var previewImage: ImageView
    private lateinit var zoomSeek: SeekBar
    private lateinit var widestButton: Button
    private lateinit var defaultButton: Button
    private lateinit var authorizeButton: Button

    private var activeTab = SettingsTab.Pairing
    private var preview: ExternalWebcamPreview? = null
    private var previewSessionId: Int = 0
    private var liveCapability: UvcZoomCapability = UvcZoomCapability.UNSUPPORTED
    private var openedZoomIdentity: String? = null
    private var openedAttachmentKey: String? = null
    private var selectedDevice: UvcDeviceInfo? = null
    private var updatingSeek = false
    private var destroyed = false
    private val zoomRequestSeq = AtomicInteger(0)
    private val controllerPoll = object : Runnable {
        override fun run() {
            if (!uiAlive(SettingsTab.Controllers)) return
            refreshControllers()
            uiHandler.postDelayed(this, 1_000L)
        }
    }
    private var pendingZoomRequestId: Int = -1
    private var uiBitmap: Bitmap? = null
    private var uiPixels: IntArray? = null

    private val detachListener = UvcCameraHost.DetachListener { deviceName, deviceKey ->
        uiHandler.post {
            if (!uiAlive(SettingsTab.Webcams)) return@post
            if (!UvcProcess.detachAffectsOpened(openedAttachmentKey, deviceName, deviceKey)) {
                // Unrelated UVC removal — refresh the list but keep the live preview.
                refreshWebcams(startPreview = false)
                return@post
            }
            stopPreview()
            statusText.text = getString(R.string.webcam_status_disconnected)
            setZoomUnsupported(getString(R.string.webcam_zoom_unsupported))
            refreshWebcams(startPreview = false)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        UvcProcess.acquire(this, this).addDetachListener(detachListener)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(buildUi())
        showTab(SettingsTab.Pairing)
    }

    override fun onResume() {
        super.onResume()
        bindPairing()
        if (activeTab == SettingsTab.Webcams) refreshWebcams(startPreview = true)
        if (activeTab == SettingsTab.Controllers) startControllerPolling()
    }

    override fun onPause() {
        uiHandler.removeCallbacks(controllerPoll)
        stopPreview()
        super.onPause()
    }

    override fun onDestroy() {
        destroyed = true
        uiHandler.removeCallbacks(controllerPoll)
        stopPreview()
        UvcProcess.hostOrNull()?.removeDetachListener(detachListener)
        UvcProcess.release(this)
        super.onDestroy()
    }

    private fun uiAlive(requiredTab: SettingsTab? = null): Boolean {
        if (destroyed || isFinishing) return false
        if (requiredTab != null && activeTab != requiredTab) return false
        return true
    }

    private fun bindPairing() {
        endpointValue.text = "http://" + LanEndpointDisplay.format(BridgeHttpJson.DEFAULT_PORT)
        tokenValue.text = PairingToken.grouped(BridgeProcess.pairing(this).token())
    }

    private fun confirmRegenerate() {
        AlertDialog.Builder(this)
            .setTitle(R.string.pairing_regenerate_title)
            .setMessage(R.string.pairing_regenerate_message)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.pairing_regenerate) { _, _ ->
                BridgeProcess.pairing(this).regenerate()
                bindPairing()
            }
            .show()
    }

    private fun showTab(tab: SettingsTab) {
        activeTab = tab
        pairingPanel.visibility = if (tab == SettingsTab.Pairing) View.VISIBLE else View.GONE
        webcamPanel.visibility = if (tab == SettingsTab.Webcams) View.VISIBLE else View.GONE
        controllerPanel.visibility = if (tab == SettingsTab.Controllers) View.VISIBLE else View.GONE
        styleTab(pairingTab, tab == SettingsTab.Pairing)
        styleTab(webcamTab, tab == SettingsTab.Webcams)
        styleTab(controllerTab, tab == SettingsTab.Controllers)
        uiHandler.removeCallbacks(controllerPoll)
        if (tab == SettingsTab.Webcams) {
            refreshWebcams(startPreview = true)
        } else {
            stopPreview()
        }
        if (tab == SettingsTab.Controllers) startControllerPolling()
    }

    private fun startControllerPolling() {
        uiHandler.removeCallbacks(controllerPoll)
        if (!uiAlive(SettingsTab.Controllers)) return
        refreshControllers()
        uiHandler.postDelayed(controllerPoll, 1_000L)
    }

    private fun refreshControllers() {
        val devices = ControllerDevices.visible()
        controllerList.text = if (devices.isEmpty()) {
            "No controllers or pointers detected"
        } else devices.joinToString("\n\n") { device ->
            val kind = ControllerDevices.category(device)
            val playable = if (ControllerDevices.supportsGames(device)) "Game input available" else "Pointer only; no game input"
            device.name + "\n" + device.vendorId.toString(16) + ":" + device.productId.toString(16) +
                " | " + kind + "\n" + playable
        }
        val selected = getSharedPreferences(ControllerDevices.PREFS, MODE_PRIVATE)
            .getString(ControllerDevices.SELECTED, null)
        val active = ControllerDevices.chosen(devices, selected)
        controllerSelection.text = when {
            selected == ControllerDevices.DISABLED -> "Game controls disabled"
            active != null -> "Selected: " + active.name
            selected == null -> "Auto-select: " + (
                if (devices.any(ControllerDevices::supportsGames)) "choose a device if multiple are connected"
                else "no game controller available"
            )
            else -> "Selected controller disconnected; reconnect it or choose another"
        }
    }

    private fun chooseController() {
        val devices = ControllerDevices.visible().filter(ControllerDevices::supportsGames)
        val options = listOf("Auto-select (one controller only)", "Disable controller steering") +
            devices.map { it.name + " (" + ControllerDevices.category(it) + ")" }
        AlertDialog.Builder(this)
            .setTitle("Game controller")
            .setItems(options.toTypedArray()) { _, index ->
                val descriptor = when (index) {
                    0 -> null
                    1 -> ControllerDevices.DISABLED
                    else -> devices[index - 2].descriptor
                }
                getSharedPreferences(ControllerDevices.PREFS, MODE_PRIVATE).edit()
                    .putString(ControllerDevices.SELECTED, descriptor)
                    .apply()
                refreshControllers()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val device = InputDevice.getDevice(event.deviceId)
        if (activeTab == SettingsTab.Controllers && device != null && ControllerDevices.supportsGames(device)) {
            if (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_UP) {
                val action = if (event.action == KeyEvent.ACTION_DOWN) "pressed" else "released"
                controllerEvents.text = device.name + ": " + KeyEvent.keyCodeToString(event.keyCode) + " " + action
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        val device = InputDevice.getDevice(event.deviceId)
        if (activeTab == SettingsTab.Controllers && device != null &&
            ControllerDevices.supportsGames(device) && event.isFromSource(InputDevice.SOURCE_JOYSTICK)
        ) {
            val x = event.getAxisValue(MotionEvent.AXIS_X)
            val y = event.getAxisValue(MotionEvent.AXIS_Y)
            val hat = event.getAxisValue(MotionEvent.AXIS_HAT_X)
            controllerEvents.text = device.name + ": stick X=" + "%.2f".format(x) +
                " Y=" + "%.2f".format(y) + "  D-pad axis=" + "%.2f".format(hat)
        }
        return super.dispatchGenericMotionEvent(event)
    }

    private fun styleTab(tab: TextView, selected: Boolean) {
        tab.setTextColor(if (selected) Color.WHITE else MUTE)
        tab.setBackgroundColor(if (selected) Color.rgb(40, 40, 40) else Color.TRANSPARENT)
    }

    private fun refreshWebcams(startPreview: Boolean) {
        val host = UvcProcess.acquire(this, this)
        val devices = host.listDevices().filter(UvcDeviceSelector::isExternalUvc).sortedBy { it.deviceName }
        val selected = UvcProcess.selectedDevice(this)
        selectedDevice = selected
        if (devices.isEmpty()) {
            cameraList.text = getString(R.string.webcam_none)
            statusText.text = getString(R.string.webcam_status_disconnected)
            setZoomUnsupported(getString(R.string.webcam_zoom_unsupported))
            previewImage.setImageDrawable(null)
            stopPreview()
            return
        }
        val lines = devices.joinToString("\n") { device ->
            val perm = if (host.hasPermission(device.deviceName)) "authorized" else "needs USB permission"
            val marker = if (selected != null && selected.key == device.key) "▶ " else "  "
            String.format(
                "%s%04X:%04X  %s\n   %s",
                marker,
                device.vendorId and 0xffff,
                device.productId and 0xffff,
                device.serial?.takeIf { it.isNotBlank() } ?: "(no serial)",
                perm,
            )
        }
        cameraList.text = lines
        authorizeButton.isEnabled = selected != null && !host.hasPermission(selected.deviceName)
        if (!startPreview) return
        if (selected == null) {
            statusText.text = getString(R.string.webcam_status_disconnected)
            setZoomUnsupported(getString(R.string.webcam_zoom_unsupported))
            return
        }
        if (!host.hasPermission(selected.deviceName)) {
            statusText.text = getString(R.string.webcam_status_needs_permission)
            setZoomUnsupported(getString(R.string.webcam_zoom_unsupported))
            stopPreview()
            host.promptUsbPermission()
            return
        }
        startPreviewSession()
    }

    private fun startPreviewSession() {
        stopPreview()
        statusText.text = getString(R.string.webcam_status_opening)
        openedZoomIdentity = null
        val session = ExternalWebcamPreview(
            external = UvcProcess.acquire(this, this),
            zoomHook = UvcProcess.zoomHook(this),
        )
        preview = session
        session.start(object : ExternalWebcamPreview.Listener {
            override fun onStatus(sessionId: Int, message: String) {
                uiHandler.post {
                    if (!previewMatches(session, sessionId)) return@post
                    statusText.text = message
                }
            }

            override fun onReady(
                sessionId: Int,
                width: Int,
                height: Int,
                capability: UvcZoomCapability,
                zoomIdentity: String?,
                attachmentKey: String?,
            ) {
                uiHandler.post {
                    if (!previewMatches(session, sessionId)) return@post
                    previewSessionId = sessionId
                    openedZoomIdentity = zoomIdentity
                    openedAttachmentKey = attachmentKey
                    // Keep list marker aligned with the device that produced this stream.
                    selectedDevice = selectedDevice?.takeIf { it.key == attachmentKey }
                        ?: UvcProcess.selectedDevice(this@PairingActivity)
                    liveCapability = capability
                    statusText.text = getString(R.string.webcam_status_live, width, height)
                    bindZoomControls(capability)
                    refreshWebcams(startPreview = false)
                }
            }

            override fun onFrame(frame: ExternalWebcamPreview.PreviewFrame) {
                uiHandler.post {
                    if (!previewMatches(session, frame.sessionId)) {
                        session.releaseFrame(frame)
                        return@post
                    }
                    try {
                        presentFrame(frame)
                    } finally {
                        session.releaseFrame(frame)
                    }
                }
            }

            override fun onFailed(sessionId: Int, reason: String) {
                uiHandler.post {
                    if (!previewMatches(session, sessionId)) return@post
                    statusText.text = reason
                    setZoomUnsupported(getString(R.string.webcam_zoom_unsupported))
                    previewImage.setImageDrawable(null)
                }
            }

            override fun onStopped(sessionId: Int) {
                uiHandler.post {
                    if (preview === session && previewSessionId == sessionId) {
                        preview = null
                    }
                }
            }

            override fun onZoomResult(result: ExternalWebcamPreview.ZoomResult) {
                uiHandler.post {
                    if (!previewMatches(session, result.sessionId)) return@post
                    if (result.requestId != pendingZoomRequestId) return@post
                    val preference = pendingPreference
                    pendingPreference = null
                    pendingZoomRequestId = -1
                    if (!result.ok) {
                        statusText.text = getString(R.string.webcam_zoom_failed)
                        return@post
                    }
                    val identity = openedZoomIdentity
                    if (identity != null && preference != null) {
                        WebcamZoomStore.save(this@PairingActivity, identity, preference)
                    }
                    if (result.readbackOk && result.capability.supported) {
                        // Display device-reported GET_CUR, not the requested value.
                        liveCapability = result.capability
                        bindZoomControls(liveCapability)
                        statusText.text = getString(R.string.webcam_zoom_applied, result.capability.current)
                    } else {
                        // Write succeeded but state is unverified — do not present as confirmed FOV.
                        statusText.text = getString(R.string.webcam_zoom_unverified, result.value)
                    }
                }
            }
        })
        previewSessionId = session.sessionId()
    }

    private fun previewMatches(session: ExternalWebcamPreview, sessionId: Int): Boolean =
        uiAlive(SettingsTab.Webcams) && preview === session && session.sessionId() == sessionId

    private fun presentFrame(frame: ExternalWebcamPreview.PreviewFrame) {
        val count = frame.width * frame.height
        if (frame.pixels.size < count) return
        var pixels = uiPixels
        if (pixels == null || pixels.size != count) {
            pixels = IntArray(count)
            uiPixels = pixels
        }
        System.arraycopy(frame.pixels, 0, pixels, 0, count)
        var bitmap = uiBitmap
        if (bitmap == null || bitmap.width != frame.width || bitmap.height != frame.height) {
            bitmap = Bitmap.createBitmap(frame.width, frame.height, Bitmap.Config.ARGB_8888)
            uiBitmap = bitmap
        }
        bitmap.setPixels(pixels, 0, frame.width, 0, 0, frame.width, frame.height)
        previewImage.setImageBitmap(bitmap)
    }

    private fun stopPreview() {
        pendingZoomRequestId = -1
        val session = preview
        preview = null
        previewSessionId = 0
        openedZoomIdentity = null
        openedAttachmentKey = null
        session?.stop()
        previewImage.setImageDrawable(null)
    }

    private fun bindZoomControls(capability: UvcZoomCapability) {
        if (!capability.supported) {
            setZoomUnsupported(getString(R.string.webcam_zoom_unsupported))
            return
        }
        zoomSeek.isEnabled = true
        widestButton.isEnabled = true
        defaultButton.isEnabled = true
        zoomSeek.max = ((capability.max - capability.min) / capability.step).coerceAtLeast(0)
        updatingSeek = true
        zoomSeek.progress = ((capability.current - capability.min) / capability.step).coerceIn(0, zoomSeek.max)
        updatingSeek = false
        zoomStatus.text = getString(
            R.string.webcam_zoom_range,
            capability.min,
            capability.max,
            capability.step,
            capability.default,
            capability.current,
        )
    }

    private fun setZoomUnsupported(message: String) {
        liveCapability = UvcZoomCapability.UNSUPPORTED
        zoomSeek.isEnabled = false
        widestButton.isEnabled = false
        defaultButton.isEnabled = false
        updatingSeek = true
        zoomSeek.progress = 0
        updatingSeek = false
        zoomStatus.text = message
    }

    private fun applyZoomPreference(preference: UvcZoomPreference) {
        val session = preview ?: return
        if (!liveCapability.supported) {
            setZoomUnsupported(getString(R.string.webcam_zoom_unsupported))
            return
        }
        val value = preference.resolve(liveCapability) ?: return
        val requestId = zoomRequestSeq.incrementAndGet()
        pendingZoomRequestId = requestId
        pendingPreference = preference
        session.requestSetZoom(value, requestId)
    }

    private var pendingPreference: UvcZoomPreference? = null

    private fun buildUi(): View {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setBackgroundColor(Color.BLACK)
        val pad = dp(16)
        root.setPadding(pad, dp(10), pad, dp(10))

        val title = label("FITBAUS", 16f, Color.WHITE)
        title.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        title.letterSpacing = 0.18f
        root.addView(title, marginBottom(dp(4)))

        root.addView(buildTabs(), marginBottom(dp(8)))

        val rule = View(this)
        rule.setBackgroundColor(DIVIDER)
        root.addView(rule, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)))

        val body = LinearLayout(this)
        body.orientation = LinearLayout.VERTICAL
        pairingPanel = buildPairingPanel()
        webcamPanel = buildWebcamPanel()
        controllerPanel = buildControllerPanel()
        body.addView(pairingPanel)
        body.addView(webcamPanel)
        body.addView(controllerPanel)
        val scroll = ScrollView(this)
        scroll.isFillViewport = true
        scroll.addView(body)
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        val doneRow = LinearLayout(this)
        doneRow.orientation = LinearLayout.HORIZONTAL
        doneRow.gravity = Gravity.END
        val done = Button(this)
        done.setText(R.string.pairing_done)
        done.setOnClickListener { finish() }
        doneRow.addView(done)
        val doneLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        doneLp.topMargin = dp(8)
        root.addView(doneRow, doneLp)
        return root
    }

    private fun buildTabs(): LinearLayout {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        val outline = GradientDrawable()
        outline.setStroke(dp(1), DIVIDER)
        outline.cornerRadius = dp(4).toFloat()
        row.background = outline
        pairingTab = tabLabel(getString(R.string.settings_tab_pairing)) {
            showTab(SettingsTab.Pairing)
        }
        webcamTab = tabLabel(getString(R.string.settings_tab_webcams)) {
            showTab(SettingsTab.Webcams)
        }
        controllerTab = tabLabel(getString(R.string.settings_tab_controllers)) {
            showTab(SettingsTab.Controllers)
        }
        row.addView(pairingTab, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(webcamTab, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(controllerTab, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        return row
    }

    private fun tabLabel(text: String, onClick: () -> Unit): TextView {
        val tab = label(text, 12f, MUTE)
        tab.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        tab.letterSpacing = 0.1f
        tab.gravity = Gravity.CENTER
        tab.setPadding(dp(12), dp(8), dp(12), dp(8))
        tab.isClickable = true
        tab.setOnClickListener { onClick() }
        return tab
    }

    private fun buildPairingPanel(): View {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setPadding(0, dp(8), 0, 0)

        val heading = label(getString(R.string.pairing_heading), 11f, MUTE)
        heading.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        heading.letterSpacing = 0.12f
        root.addView(heading, marginBottom(dp(4)))

        endpointValue = addRow(root, "ENDPOINT", 12f)
        addRow(root, "HEADER", 12f).text = BridgeHttpRouter.PAIRING_HEADER
        tokenValue = addRow(root, "TOKEN", 24f)

        val note = label(getString(R.string.pairing_note), 12f, MUTE)
        val noteLp = marginBottom(dp(16))
        noteLp.topMargin = dp(12)
        root.addView(note, noteLp)

        val regenerate = Button(this)
        regenerate.setText(R.string.pairing_regenerate)
        regenerate.setOnClickListener { confirmRegenerate() }
        root.addView(regenerate)
        return root
    }

    private fun buildControllerPanel(): View {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setPadding(0, dp(8), 0, 0)
        val heading = label("CONNECTED INPUT DEVICES", 11f, MUTE)
        heading.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        root.addView(heading, marginBottom(dp(8)))

        controllerList = label("", 13f, Color.WHITE)
        root.addView(controllerList, marginBottom(dp(12)))

        controllerSelection = label("", 13f, Color.WHITE)
        root.addView(controllerSelection, marginBottom(dp(8)))

        val choose = Button(this)
        choose.text = "Choose game controller"
        choose.setOnClickListener { chooseController() }
        root.addView(choose, marginBottom(dp(12)))

        val hint = label(
            "Use the D-pad or left stick to steer the paddle in BRICKS. In other games, camera and bike controls are unchanged. Pointer-only USB devices can navigate Android but do not supply gamepad buttons.",
            13f,
            MUTE,
        )
        root.addView(hint, marginBottom(dp(12)))

        val eventLabel = label("LIVE INPUT DIAGNOSTICS", 11f, MUTE)
        eventLabel.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        root.addView(eventLabel, marginBottom(dp(6)))
        controllerEvents = label("Press D-pad buttons or move the stick to test input", 13f, Color.WHITE)
        root.addView(controllerEvents)
        return root
    }

    private fun buildWebcamPanel(): View {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setPadding(0, dp(8), 0, 0)

        val heading = label(getString(R.string.webcam_heading), 11f, MUTE)
        heading.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        heading.letterSpacing = 0.12f
        root.addView(heading, marginBottom(dp(4)))

        cameraList = label("", 12f, Color.WHITE)
        cameraList.setTypeface(Typeface.MONOSPACE, Typeface.NORMAL)
        root.addView(cameraList, marginBottom(dp(8)))

        statusText = label(getString(R.string.webcam_status_idle), 12f, MUTE)
        root.addView(statusText, marginBottom(dp(8)))

        val previewRow = LinearLayout(this)
        previewRow.orientation = LinearLayout.HORIZONTAL
        previewRow.gravity = Gravity.CENTER_VERTICAL
        previewImage = ImageView(this)
        previewImage.scaleType = ImageView.ScaleType.FIT_CENTER
        previewImage.setBackgroundColor(Color.rgb(24, 24, 24))
        previewRow.addView(previewImage, LinearLayout.LayoutParams(dp(240), dp(180)))

        val controls = LinearLayout(this)
        controls.orientation = LinearLayout.VERTICAL
        controls.setPadding(dp(12), 0, 0, 0)
        zoomStatus = label(getString(R.string.webcam_zoom_unsupported), 11f, MUTE)
        controls.addView(zoomStatus, marginBottom(dp(6)))
        zoomSeek = SeekBar(this)
        zoomSeek.isEnabled = false
        zoomSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {}
            override fun onStartTrackingTouch(seekBar: SeekBar?) {}
            override fun onStopTrackingTouch(seekBar: SeekBar?) {
                if (updatingSeek || !liveCapability.supported) return
                val value = liveCapability.min + zoomSeek.progress * liveCapability.step
                applyZoomPreference(UvcZoomPreference.Absolute(value))
            }
        })
        controls.addView(zoomSeek, marginBottom(dp(6)))

        val buttons = LinearLayout(this)
        buttons.orientation = LinearLayout.HORIZONTAL
        widestButton = Button(this)
        widestButton.setText(R.string.webcam_widest)
        widestButton.isEnabled = false
        widestButton.setOnClickListener { applyZoomPreference(UvcZoomPreference.Widest) }
        buttons.addView(widestButton)
        defaultButton = Button(this)
        defaultButton.setText(R.string.webcam_camera_default)
        defaultButton.isEnabled = false
        defaultButton.setOnClickListener { applyZoomPreference(UvcZoomPreference.CameraDefault) }
        val defaultLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        defaultLp.leftMargin = dp(8)
        buttons.addView(defaultButton, defaultLp)
        controls.addView(buttons, marginBottom(dp(6)))

        authorizeButton = Button(this)
        authorizeButton.setText(R.string.webcam_authorize)
        authorizeButton.setOnClickListener { refreshWebcams(startPreview = true) }
        controls.addView(authorizeButton)

        previewRow.addView(controls, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(previewRow)
        return root
    }

    private fun addRow(parent: LinearLayout, caption: String, valueSp: Float): TextView {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        val cap = label(caption, 12f, MUTE)
        cap.setTypeface(Typeface.DEFAULT_BOLD, Typeface.NORMAL)
        row.addView(cap, LinearLayout.LayoutParams(dp(108), ViewGroup.LayoutParams.WRAP_CONTENT))
        val value = label("", valueSp, Color.WHITE)
        value.setTypeface(Typeface.MONOSPACE, Typeface.NORMAL)
        value.setTextIsSelectable(true)
        row.addView(value, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        parent.addView(row, marginBottom(dp(2)))
        return value
    }

    private fun marginBottom(px: Int): LinearLayout.LayoutParams {
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        lp.bottomMargin = px
        return lp
    }

    private fun label(text: String, sizeSp: Float, color: Int): TextView {
        val view = TextView(this)
        view.text = text
        view.textSize = sizeSp
        view.setTextColor(color)
        return view
    }

    private fun dp(value: Int): Int = BridgeUiStateMapper.dp(value, resources.displayMetrics.density)

    private companion object {
        val MUTE: Int = Color.rgb(140, 140, 140)
        val DIVIDER: Int = Color.rgb(48, 48, 48)
    }
}
