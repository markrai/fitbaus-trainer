// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.fitbaus.arcade.ArcadeCameraInfo
import com.fitbaus.arcade.ArcadeCameraSession
import com.fitbaus.arcade.ArcadeClock
import com.fitbaus.arcade.ArcadeStatusResolver
import com.fitbaus.arcade.ArcadeStopReason
import com.fitbaus.arcade.ArcadeTrackerMode
import com.fitbaus.arcade.ArcadeTrackerSettings
import com.fitbaus.arcade.BikeMotionMonitor
import com.fitbaus.arcade.HandPositionInput
import com.fitbaus.arcade.RateMeter
import com.fitbaus.bikebridge.host.arcade.ArcadeContent
import com.fitbaus.bikebridge.host.arcade.ArcadeMode
import com.fitbaus.bikebridge.host.arcade.ArcadeModeController
import com.fitbaus.bikebridge.host.arcade.ArcadeModeHooks
import com.fitbaus.bikebridge.protocol.BridgeHttpJson
import com.fitbaus.bikebridge.protocol.NativeTelemetrySnapshot

class NativeBridgeActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var rpmValue: TextView
    private lateinit var wattsValue: TextView
    private lateinit var resistanceValue: TextView
    private lateinit var hrValue: TextView
    private lateinit var statusValue: TextView
    private lateinit var usbValue: TextView
    private lateinit var initValue: TextView
    private lateinit var bikeValue: TextView
    private lateinit var controlValue: TextView
    private lateinit var requestedValue: TextView
    private lateinit var observedValue: TextView
    private lateinit var machineValue: TextView
    private lateinit var bridgeValue: TextView
    private lateinit var httpValue: TextView
    private var appliedBrightnessRevision = -1
    private var endpointTicks = 0
    private var endpointText = ""
    private lateinit var dashboardContent: View
    private lateinit var arcadeContent: ArcadeContent
    private val modeTabs = HashMap<ArcadeMode, TextView>()
    private val handInput = HandPositionInput()
    private val bikeMotion = BikeMotionMonitor()
    private val trackerRate = RateMeter()
    private var arcadeDiagnostics = ""
    private val cameraSession by lazy {
        ArcadeCameraSession.forActivity(this, handInput, CAMERA_PERMISSION_REQUEST, settings = savedTrackerSettings())
    }
    private val arcadeClock by lazy { ArcadeClock(handler) { arcadeTick() } }

    // Mode switches only swap content views and the arcade's own camera/clock. They never start,
    // stop, or restart NativeBridgeService or its USB session.
    private val arcadeHooks = object : ArcadeModeHooks {
        override fun showMode(mode: ArcadeMode) {
            showContent(mode)
        }

        override fun activateArcade(game: ArcadeMode) {
            trackerRate.reset()
            arcadeDiagnostics = ""
            bikeMotion.reset()
            cameraSession.updateSettings(trackerSettingsFor(game))
            cameraSession.start()
            arcadeClock.start()
        }

        override fun deactivateArcade(reason: ArcadeStopReason) {
            arcadeClock.stop()
            cameraSession.stop(reason)
            arcadeContent.trail.pause()
        }
    }
    private val modeController = ArcadeModeController(arcadeHooks)

    private val refresh = object : Runnable {
        override fun run() {
            applyState()
            handler.postDelayed(this, REFRESH_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(buildUi())
        startBridgeService()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        startBridgeService()
    }

    override fun onResume() {
        super.onResume()
        appliedBrightnessRevision = -1
        applyStoredBrightness()
        bindHttpEndpoint(force = true)
        handler.removeCallbacks(refresh)
        handler.post(refresh)
        modeController.onHostResume()
    }

    override fun onPause() {
        modeController.onHostPause()
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    override fun onDestroy() {
        modeController.onHostDestroy()
        handler.removeCallbacks(refresh)
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode != CAMERA_PERMISSION_REQUEST) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        cameraSession.onPermissionResult(granted)
    }

    private fun startBridgeService() {
        val service = Intent(this, NativeBridgeService::class.java).setAction(HostConstants.ACTION_USB_RECHECK)
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(service)
        } else {
            startService(service)
        }
    }

    private fun applyState() {
        val service = NativeBridgeService.instance
        val session = service?.session()
        val telemetry: NativeTelemetrySnapshot? = session?.snapshot()
        val state = if (session == null || telemetry == null) {
            BridgeUiStateMapper.starting()
        } else {
            BridgeUiStateMapper.map(session.phase(), session.statusLine(), telemetry)
        }
        bindGridValue(rpmValue, BridgeUiStateMapper.currentValue(telemetry?.rpm), RPM_COLOR)
        bindGridValue(wattsValue, BridgeUiStateMapper.currentValue(telemetry?.watts), WATTS_COLOR)
        bindGridValue(resistanceValue, BridgeUiStateMapper.currentValue(telemetry?.resistance), RESISTANCE_COLOR)
        val heartRate = BridgeProcess.heartRate().view()
        bindGridValue(hrValue, heartRate?.bpm, if (heartRate?.fresh == true) HR_COLOR else MUTE)
        setIfChanged(statusValue, BridgeUiStateMapper.statusRow(state))
        setIfChanged(usbValue, state.usbText)
        setIfChanged(initValue, state.initText)
        setIfChanged(bikeValue, BridgeUiStateMapper.bikeRow(telemetry))
        setIfChanged(controlValue, BridgeUiStateMapper.controlRow(telemetry))
        setIfChanged(requestedValue, BridgeUiStateMapper.formatGrid(telemetry?.requestedResistance))
        setIfChanged(observedValue, BridgeUiStateMapper.formatGrid(BridgeUiStateMapper.currentValue(telemetry?.resistance)))
        setIfChanged(machineValue, state.machineText)
        setIfChanged(bridgeValue, BridgeHttpJson.VERSION)
        bindHttpEndpoint(force = false)
        applyStoredBrightness()
    }

    private fun arcadeTick() {
        val now = System.nanoTime()
        val telemetry = NativeBridgeService.instance?.session()?.snapshot()
        val heartRate = BridgeProcess.heartRate().view()
        arcadeContent.hud.bind(
            BridgeUiStateMapper.currentValue(telemetry?.rpm),
            BridgeUiStateMapper.currentValue(telemetry?.watts),
            BridgeUiStateMapper.currentValue(telemetry?.resistance),
            heartRate?.bpm,
            heartRate?.fresh == true,
        )
        val info = cameraSession.info()
        if (modeController.mode == ArcadeMode.Math) {
            val motion = bikeMotion.update(
                connected = telemetry?.connected == true,
                initialized = telemetry?.initialized == true,
                rpm = telemetry?.rpm?.value,
                rpmCurrent = telemetry?.rpm?.current == true,
                rpmObservedAt = telemetry?.rpm?.observedAt,
                nowNanos = now,
            )
            arcadeContent.math.render(cameraSession.state(), cameraSession.failureReason(), motion, arcadeDiagnosticsText(now, info), info)
            return
        }
        if (modeController.mode == ArcadeMode.Flak) {
            arcadeContent.flak.render(
                handInput.latest(now),
                cameraSession.state(),
                cameraSession.failureReason(),
                connected = telemetry?.connected == true,
                initialized = telemetry?.initialized == true,
                rpm = telemetry?.rpm?.value,
                rpmCurrent = telemetry?.rpm?.current == true,
                rpmObservedAt = telemetry?.rpm?.observedAt,
                diagnostics = arcadeDiagnosticsText(now, info),
                cameraInfo = info,
            )
            return
        }
        if (modeController.mode == ArcadeMode.TrailRide) {
            arcadeContent.trail.render(
                handInput.latest(now),
                cameraSession.state(),
                cameraSession.failureReason(),
                connected = telemetry?.connected == true,
                initialized = telemetry?.initialized == true,
                rpm = telemetry?.rpm?.value,
                rpmCurrent = telemetry?.rpm?.current == true,
                rpmObservedAt = telemetry?.rpm?.observedAt,
                diagnostics = arcadeDiagnosticsText(now, info),
                cameraInfo = info,
            )
            return
        }
        val position = handInput.latest(now)
        val status = ArcadeStatusResolver.resolve(
            cameraSession.state(),
            handInput.cameraTracking(now),
            handInput.hasEverTracked(),
        )
        arcadeContent.playground.render(position, status, arcadeDiagnosticsText(now, info), info)
    }

    private fun arcadeDiagnosticsText(now: Long, info: ArcadeCameraInfo?): String {
        if (info == null) {
            trackerRate.reset()
            return cameraSession.failureReason() ?: ""
        }
        if (trackerRate.update(info.processedFrames, now) || arcadeDiagnostics.isEmpty()) {
            arcadeDiagnostics = info.summary(cameraSession.settings.label)
        }
        return arcadeDiagnostics
    }

    private fun showContent(mode: ArcadeMode) {
        dashboardContent.visibility = if (mode.isGame) View.GONE else View.VISIBLE
        arcadeContent.visibility = if (mode.isGame) View.VISIBLE else View.GONE
        if (mode.isGame) arcadeContent.show(mode)
        for ((tabMode, tab) in modeTabs) styleTab(tab, tabMode == mode)
    }

    private fun styleTab(tab: TextView, selected: Boolean) {
        tab.setTextColor(if (selected) PRIMARY else MUTE)
        tab.setBackgroundColor(if (selected) DIVIDER else Color.TRANSPARENT)
    }

    private fun bindHttpEndpoint(force: Boolean) {
        if (!::httpValue.isInitialized) return
        endpointTicks += 1
        if (force || endpointTicks >= ENDPOINT_REFRESH_TICKS || endpointText.isEmpty()) {
            endpointTicks = 0
            endpointText = LanEndpointDisplay.format(BridgeHttpJson.DEFAULT_PORT)
        }
        val service = NativeBridgeService.instance
        val error = service?.httpError()
        val text = if (service != null && !service.isHttpListening() && error != null) {
            "Not listening - $error"
        } else {
            endpointText
        }
        setIfChanged(httpValue, text)
    }

    private fun applyStoredBrightness() {
        val store = BridgeProcess.brightness(this)
        val revision = store.revision
        if (revision == appliedBrightnessRevision) return
        appliedBrightnessRevision = revision
        val percent = store.percent() ?: return
        if (isFinishing) return
        val attrs = window.attributes
        attrs.screenBrightness = BrightnessLimits.toWindowBrightness(percent)
        window.attributes = attrs
    }

    private fun bindGridValue(view: TextView, value: Int?, live: Int) {
        setIfChanged(view, BridgeUiStateMapper.formatGrid(value))
        val color = if (value != null) live else MUTE
        if (view.currentTextColor != color) view.setTextColor(color)
    }

    private fun setIfChanged(view: TextView, text: String) {
        if (view.text.toString() != text) view.text = text
    }

    private fun buildUi(): View {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setBackgroundColor(BACKGROUND)
        val pad = dp(16)
        root.setPadding(pad, dp(10), pad, dp(10))

        root.addView(buildTitleRow())

        val contentHost = FrameLayout(this)
        dashboardContent = buildDashboard()
        contentHost.addView(
            dashboardContent,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        arcadeContent = ArcadeContent(this)
        arcadeContent.playground.input = handInput
        arcadeContent.playground.preview = cameraSession.preview
        arcadeContent.playground.faceControl = savedTrackerSettings().mode == ArcadeTrackerMode.Face
        arcadeContent.math.fingers = cameraSession.fingers
        arcadeContent.math.preview = cameraSession.preview
        val overlay = getSharedPreferences(ARCADE_DEV_PREFS, Context.MODE_PRIVATE).getBoolean(ARCADE_OVERLAY_KEY, false)
        arcadeContent.playground.diagnosticsOverlay = overlay
        arcadeContent.math.diagnosticsOverlay = overlay
        arcadeContent.flak.diagnosticsOverlay = overlay
        arcadeContent.trail.diagnosticsOverlay = overlay
        contentHost.addView(
            arcadeContent,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        root.addView(contentHost, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        showContent(modeController.mode)
        applyState()
        return root
    }

    private fun buildTitleRow(): View {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        val rowLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        rowLp.bottomMargin = dp(4)
        row.layoutParams = rowLp

        val title = label("FITBAUS", 16f, PRIMARY)
        title.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        title.letterSpacing = 0.18f
        title.isLongClickable = true
        title.setOnLongClickListener {
            startActivity(Intent(this, PairingActivity::class.java))
            true
        }
        row.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        row.addView(tabGroup(ArcadeMode.Dashboard))
        val gamesLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        gamesLp.leftMargin = dp(GAME_TAB_GAP_DP)
        row.addView(tabGroup(ArcadeMode.Bricks, ArcadeMode.Math, ArcadeMode.Flak, ArcadeMode.TrailRide), gamesLp)
        return row
    }

    private fun tabGroup(vararg modes: ArcadeMode): LinearLayout {
        val group = LinearLayout(this)
        group.orientation = LinearLayout.HORIZONTAL
        val outline = GradientDrawable()
        outline.setStroke(dp(1), DIVIDER)
        outline.cornerRadius = dp(4).toFloat()
        group.background = outline
        group.setPadding(dp(1), dp(1), dp(1), dp(1))
        for (mode in modes) group.addView(modeTab(mode))
        return group
    }

    private fun modeTab(mode: ArcadeMode): TextView {
        val tab = label(mode.caption, 13f, MUTE)
        tab.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        tab.letterSpacing = 0.12f
        tab.gravity = Gravity.CENTER
        tab.setPadding(dp(16), dp(8), dp(16), dp(8))
        tab.isClickable = true
        tab.setOnClickListener { modeController.select(mode) }
        if (mode.isGame) {
            tab.setOnLongClickListener {
                showTrackerPicker(mode)
                true
            }
        }
        modeTabs[mode] = tab
        return tab
    }

    private fun savedTrackerSettings(): ArcadeTrackerSettings =
        ArcadeTrackerSettings.fromKey(getSharedPreferences(ARCADE_DEV_PREFS, Context.MODE_PRIVATE).getString(ARCADE_TRACKER_KEY, null))

    private fun savedMathSettings(): ArcadeTrackerSettings =
        ArcadeTrackerSettings.fingersFromKey(getSharedPreferences(ARCADE_DEV_PREFS, Context.MODE_PRIVATE).getString(ARCADE_MATH_TRACKER_KEY, null))

    private fun savedFlakSettings(): ArcadeTrackerSettings =
        ArcadeTrackerSettings.faceFromKey(getSharedPreferences(ARCADE_DEV_PREFS, Context.MODE_PRIVATE).getString(ARCADE_FLAK_TRACKER_KEY, null))

    private fun savedTrailSettings(): ArcadeTrackerSettings =
        ArcadeTrackerSettings.faceFromKey(getSharedPreferences(ARCADE_DEV_PREFS, Context.MODE_PRIVATE).getString(ARCADE_TRAIL_TRACKER_KEY, null))

    private fun trackerSettingsFor(game: ArcadeMode): ArcadeTrackerSettings = when (game) {
        ArcadeMode.Math -> savedMathSettings()
        ArcadeMode.Flak -> savedFlakSettings()
        ArcadeMode.TrailRide -> savedTrailSettings()
        else -> savedTrackerSettings()
    }

    // FLAK RUN and TRAIL RIDE share the face presets but keep separate tracker preferences.
    private fun showFaceGamePicker(game: ArcadeMode) {
        val trail = game == ArcadeMode.TrailRide
        val presets = ArcadeTrackerSettings.FACE_PRESETS
        val options = if (trail) arcadeContent.trail.developerOptions() else arcadeContent.flak.developerOptions()
        val overlay = if (trail) arcadeContent.trail.diagnosticsOverlay else arcadeContent.flak.diagnosticsOverlay
        val current = presets.indexOf(trackerSettingsFor(game))
        val labels = presets.map { (if (it == presets.getOrNull(current)) "[x] " else "[ ] ") + it.label } + options +
            (if (overlay) "Diagnostics overlay: ON (tap to hide)" else "Diagnostics overlay: OFF (tap to show)")
        AlertDialog.Builder(this)
            .setTitle("${game.caption} (developer)")
            .setItems(labels.toTypedArray()) { dialog, which ->
                dialog.dismiss()
                when {
                    which < presets.size -> applyTrackerSettings(game, presets[which])
                    which < presets.size + options.size -> {
                        val option = which - presets.size
                        if (trail) arcadeContent.trail.selectDeveloperOption(option) else arcadeContent.flak.selectDeveloperOption(option)
                        showFaceGamePicker(game)
                    }
                    else -> setDiagnosticsOverlay(!overlay)
                }
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun showTrackerPicker(game: ArcadeMode) {
        if (game == ArcadeMode.Flak || game == ArcadeMode.TrailRide) {
            showFaceGamePicker(game)
            return
        }
        val presets = if (game == ArcadeMode.Math) ArcadeTrackerSettings.FINGER_PRESETS else ArcadeTrackerSettings.PRESETS
        val current = presets.indexOf(trackerSettingsFor(game)).coerceAtLeast(0)
        val overlay = arcadeContent.playground.diagnosticsOverlay
        val labels = presets.map { it.label } + (if (overlay) "Diagnostics overlay: ON (tap to hide)" else "Diagnostics overlay: OFF (tap to show)")
        AlertDialog.Builder(this)
            .setTitle("${game.caption} tracker (developer)")
            .setSingleChoiceItems(labels.toTypedArray(), current) { dialog, which ->
                if (which < presets.size) applyTrackerSettings(game, presets[which]) else setDiagnosticsOverlay(!overlay)
                dialog.dismiss()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun setDiagnosticsOverlay(enabled: Boolean) {
        getSharedPreferences(ARCADE_DEV_PREFS, Context.MODE_PRIVATE).edit().putBoolean(ARCADE_OVERLAY_KEY, enabled).apply()
        arcadeContent.playground.diagnosticsOverlay = enabled
        arcadeContent.math.diagnosticsOverlay = enabled
        arcadeContent.flak.diagnosticsOverlay = enabled
        arcadeContent.trail.diagnosticsOverlay = enabled
    }

    private fun applyTrackerSettings(game: ArcadeMode, next: ArcadeTrackerSettings) {
        val key = when (game) {
            ArcadeMode.Math -> ARCADE_MATH_TRACKER_KEY
            ArcadeMode.Flak -> ARCADE_FLAK_TRACKER_KEY
            ArcadeMode.TrailRide -> ARCADE_TRAIL_TRACKER_KEY
            else -> ARCADE_TRACKER_KEY
        }
        getSharedPreferences(ARCADE_DEV_PREFS, Context.MODE_PRIVATE).edit().putString(key, next.key).apply()
        if (game == ArcadeMode.Bricks) arcadeContent.playground.faceControl = next.mode == ArcadeTrackerMode.Face
        if (game != modeController.mode || next == cameraSession.settings) return
        cameraSession.updateSettings(next)
        trackerRate.reset()
        arcadeDiagnostics = ""
        if (modeController.isActive) {
            cameraSession.stop(ArcadeStopReason.HostPaused)
            cameraSession.start()
        }
    }

    private fun buildDashboard(): View {
        val dashboard = LinearLayout(this)
        dashboard.orientation = LinearLayout.VERTICAL

        dashboard.addView(
            buildStatGrid(),
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        val rule = View(this)
        rule.setBackgroundColor(DIVIDER)
        val ruleLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
        ruleLp.topMargin = dp(8)
        ruleLp.bottomMargin = dp(8)
        dashboard.addView(rule, ruleLp)

        dashboard.addView(buildDiagnostics())
        return dashboard
    }

    private fun buildStatGrid(): View {
        val grid = LinearLayout(this)
        grid.orientation = LinearLayout.HORIZONTAL
        grid.gravity = Gravity.CENTER_VERTICAL

        val metrics = resources.displayMetrics
        @Suppress("DEPRECATION")
        val scaledDensity = metrics.scaledDensity
        val valueSp = BridgeUiStateMapper.gridValueSp(
            metrics.widthPixels,
            metrics.heightPixels,
            metrics.density,
            scaledDensity,
        )
        val labelSp = 16f
        rpmValue = addStatTile(grid, "RPM", valueSp, labelSp, true)
        wattsValue = addStatTile(grid, "WATTS", valueSp, labelSp, true)
        resistanceValue = addStatTile(grid, "RESISTANCE", valueSp, labelSp, true)
        hrValue = addStatTile(grid, "HR", valueSp, labelSp, false)
        return grid
    }

    private fun addStatTile(
        grid: LinearLayout,
        caption: String,
        valueSp: Float,
        labelSp: Float,
        showDivider: Boolean,
    ): TextView {
        val tile = LinearLayout(this)
        tile.orientation = LinearLayout.VERTICAL
        tile.gravity = Gravity.CENTER
        tile.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)

        val value = label(BridgeUiStateMapper.GRID_UNKNOWN, valueSp, MUTE)
        value.setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
        value.includeFontPadding = false
        value.gravity = Gravity.CENTER
        value.maxLines = 1
        tile.addView(value)

        val label = label(caption, labelSp, LABEL_COLOR)
        label.setTypeface(Typeface.DEFAULT_BOLD, Typeface.NORMAL)
        label.gravity = Gravity.CENTER_HORIZONTAL
        label.includeFontPadding = false
        val labelLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        labelLp.topMargin = dp(6)
        labelLp.gravity = Gravity.CENTER_HORIZONTAL
        tile.addView(label, labelLp)

        grid.addView(tile)

        if (showDivider) {
            val divider = View(this)
            divider.setBackgroundColor(DIVIDER)
            grid.addView(divider, LinearLayout.LayoutParams(dp(1), ViewGroup.LayoutParams.MATCH_PARENT))
        }

        return value
    }

    private fun buildDiagnostics(): View {
        val block = LinearLayout(this)
        block.orientation = LinearLayout.VERTICAL
        block.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )

        val heading = label("DIAGNOSTICS", 11f, MUTE)
        heading.setTypeface(Typeface.DEFAULT_BOLD, Typeface.BOLD)
        heading.letterSpacing = 0.12f
        val headingLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        headingLp.bottomMargin = dp(4)
        heading.layoutParams = headingLp
        block.addView(heading)

        val columns = LinearLayout(this)
        columns.orientation = LinearLayout.HORIZONTAL

        val left = LinearLayout(this)
        left.orientation = LinearLayout.VERTICAL
        val right = LinearLayout(this)
        right.orientation = LinearLayout.VERTICAL
        left.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        val rightLp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        rightLp.leftMargin = dp(16)
        right.layoutParams = rightLp

        statusValue = addDiagRow(left, "STATUS")
        usbValue = addDiagRow(left, "USB")
        initValue = addDiagRow(left, "INIT")
        bikeValue = addDiagRow(left, "BIKE")
        controlValue = addDiagRow(left, "CONTROL")

        requestedValue = addDiagRow(right, "REQUESTED")
        observedValue = addDiagRow(right, "OBSERVED")
        machineValue = addDiagRow(right, "MACHINE")
        bridgeValue = addDiagRow(right, "BRIDGE")
        httpValue = addDiagRow(right, "HTTP")

        columns.addView(left)
        columns.addView(right)
        block.addView(columns)
        return block
    }

    private fun addDiagRow(column: LinearLayout, caption: String): TextView {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        val rowLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        rowLp.bottomMargin = dp(2)
        row.layoutParams = rowLp

        val cap = label(caption, 12f, MUTE)
        cap.setTypeface(Typeface.DEFAULT_BOLD, Typeface.NORMAL)
        cap.layoutParams = LinearLayout.LayoutParams(dp(108), ViewGroup.LayoutParams.WRAP_CONTENT)
        row.addView(cap)

        val value = label(BridgeUiStateMapper.GRID_UNKNOWN, 12f, PRIMARY)
        value.setTypeface(Typeface.MONOSPACE, Typeface.NORMAL)
        value.maxLines = 2
        row.addView(value, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        column.addView(row)
        return value
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
        const val REFRESH_MS = 200L
        const val ENDPOINT_REFRESH_TICKS = 10
        const val CAMERA_PERMISSION_REQUEST = 4101
        const val ARCADE_DEV_PREFS = "arcade_dev"
        const val ARCADE_TRACKER_KEY = "tracker"
        const val ARCADE_OVERLAY_KEY = "overlay"
        const val ARCADE_MATH_TRACKER_KEY = "math_tracker"
        const val ARCADE_FLAK_TRACKER_KEY = "flak_tracker"
        const val ARCADE_TRAIL_TRACKER_KEY = "trail_tracker"
        const val GAME_TAB_GAP_DP = 12
        val BACKGROUND: Int = Color.BLACK
        val PRIMARY: Int = Color.WHITE
        val LABEL_COLOR: Int = Color.rgb(180, 180, 180)
        val MUTE: Int = Color.rgb(140, 140, 140)
        val DIVIDER: Int = Color.rgb(48, 48, 48)
        val RPM_COLOR: Int = Color.rgb(255, 0, 255)
        val WATTS_COLOR: Int = Color.rgb(0, 150, 255)
        val RESISTANCE_COLOR: Int = Color.rgb(255, 140, 0)
        val HR_COLOR: Int = Color.rgb(255, 40, 40)
    }
}
