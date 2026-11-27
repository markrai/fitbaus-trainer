// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.fitbaus.arcade.ArcadeCameraInfo
import com.fitbaus.arcade.ArcadeCameraSession
import com.fitbaus.arcade.ArcadeClock
import com.fitbaus.arcade.ArcadeStatusResolver
import com.fitbaus.arcade.BricksInputSource
import com.fitbaus.arcade.BiketrisInputSource
import com.fitbaus.arcade.FlakInputSource
import com.fitbaus.arcade.GhoulRunInputSource
import com.fitbaus.arcade.HandPosition
import com.fitbaus.arcade.HandSource
import com.fitbaus.arcade.ArcadeStopReason
import com.fitbaus.arcade.ArcadeTrackerMode
import com.fitbaus.arcade.ArcadeTrackerSettings
import com.fitbaus.arcade.BikeMotionMonitor
import com.fitbaus.arcade.HandPositionInput
import com.fitbaus.arcade.RateMeter
import com.fitbaus.bikebridge.host.arcade.ArcadeContent
import com.fitbaus.bikebridge.host.arcade.ArcadeConfiguration
import com.fitbaus.bikebridge.host.arcade.ArcadeLifecycle
import com.fitbaus.bikebridge.host.arcade.AndroidArcadeLifecycleEffects
import com.fitbaus.bikebridge.host.arcade.AndroidArcadeConfigurationPersistence
import com.fitbaus.bikebridge.host.arcade.ArcadeTrackerPicker
import com.fitbaus.bikebridge.host.arcade.ArcadeMode
import com.fitbaus.bikebridge.host.arcade.ArcadeModeController
import com.fitbaus.bikebridge.host.arcade.ArcadeModeHooks
import com.fitbaus.bikebridge.host.books.BooksContent
import com.fitbaus.bikebridge.host.media.MediaLifecycle
import com.fitbaus.bikebridge.host.media.AndroidMediaLifecycleEffects
import com.fitbaus.bikebridge.host.controller.ControllerDevices
import com.fitbaus.bikebridge.host.controller.GameControllerInput
import com.fitbaus.bikebridge.host.controller.GameControlBindings
import com.fitbaus.bikebridge.host.controller.ExclusiveHid
import com.fitbaus.bikebridge.host.controller.AutoControllerOwnership
import com.fitbaus.bikebridge.host.uvc.UvcProcess
import com.fitbaus.bikebridge.host.youtube.BrightnessControl
import com.fitbaus.bikebridge.host.youtube.YouTubeContent
import com.fitbaus.bikebridge.host.youtube.YouTubeCredentialsImport
import com.fitbaus.bikebridge.host.youtube.Screen
import com.fitbaus.bikebridge.host.speech.OfflineVoiceSearchController
import com.fitbaus.bikebridge.protocol.NativeTelemetrySnapshot

class NativeBridgeActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private var appliedBrightnessRevision = -1
    private lateinit var dashboardContent: BridgeDashboardView
    private lateinit var arcadeContent: ArcadeContent
    private lateinit var youtubeContent: YouTubeContent
    private lateinit var booksContent: BooksContent
    private lateinit var floatingPlayer: FrameLayout
    private lateinit var floatingVideoSlot: FrameLayout
    private val mediaLifecycle by lazy {
        MediaLifecycle(AndroidMediaLifecycleEffects(youtubeContent, booksContent, floatingPlayer, floatingVideoSlot) {
            voiceSearch.cancel()
        })
    }
    private var resumed = false
    private var pendingYouTubeImport: String? = null
    private lateinit var navigationHeader: BridgeNavigationHeader
    private val arcadeConfiguration by lazy { ArcadeConfiguration(AndroidArcadeConfigurationPersistence(this)) }
    private val trackerPicker by lazy {
        ArcadeTrackerPicker(this, arcadeConfiguration, arcadeContent, ::applyTrackerSettings, ::setDiagnosticsOverlay)
    }
    private val handInput = HandPositionInput()
    private val exclusiveHid by lazy { ExclusiveHid(this) }
    private val controllerOwnership by lazy {
        AutoControllerOwnership(
            this,
            exclusiveHid,
            canClaim = {
                modeController.mode == ArcadeMode.Bricks &&
                    arcadeContent.playground.inputSource == BricksInputSource.Controller &&
                    exclusiveHid.hasCalibratedBricksInput()
            },
        )
    }
    private val gameBindings by lazy {
        GameControlBindings(getSharedPreferences(ControllerDevices.PREFS, Context.MODE_PRIVATE))
    }
    private val gameController by lazy {
        GameControllerInput(getSharedPreferences(ControllerDevices.PREFS, Context.MODE_PRIVATE))
    }
    private val bikeMotion = BikeMotionMonitor()
    private val trackerRate = RateMeter()
    private var arcadeDiagnostics = ""
    private val cameraSession by lazy {
        ArcadeCameraSession.forActivity(
            this,
            handInput,
            CAMERA_PERMISSION_REQUEST,
            settings = arcadeConfiguration.settingsFor(ArcadeMode.Bricks),
            externalCamera = UvcProcess.acquire(this, this),
            zoomHook = UvcProcess.zoomHook(this),
        )
    }
    private val arcadeClock by lazy { ArcadeClock(handler) { arcadeTick() } }
    private val arcadeLifecycle by lazy {
        ArcadeLifecycle(
            arcadeConfiguration,
            AndroidArcadeLifecycleEffects(cameraSession, arcadeClock, gameController, bikeMotion, arcadeContent) {
                trackerRate.reset()
                arcadeDiagnostics = ""
            },
        )
    }

    // Mode switches only swap content views, the arcade's own camera/clock, and the YouTube player.
    // They never start, stop, or restart NativeBridgeService or its USB session.
    private val arcadeHooks = object : ArcadeModeHooks {
        override fun showMode(mode: ArcadeMode) {
            showContent(mode)
        }

        override fun activateArcade(game: ArcadeMode) {
            arcadeLifecycle.activate(game)
        }

        override fun deactivateArcade(reason: ArcadeStopReason) {
            arcadeLifecycle.deactivate(reason)
        }

        override fun startMedia(mode: ArcadeMode) {
            mediaLifecycle.start(mode)
        }

        override fun stopMedia(reason: ArcadeStopReason) {
            mediaLifecycle.stop(modeController.mode, reason)
        }
    }
    private val modeController: ArcadeModeController = ArcadeModeController(arcadeHooks)

    private val youtubeBrightness = object : BrightnessControl {
        override fun percent(): Int = BridgeProcess.brightness(this@NativeBridgeActivity).percent() ?: systemBrightnessPercent()

        override fun set(percent: Int) {
            BridgeProcess.brightness(this@NativeBridgeActivity).record(percent)
            applyStoredBrightness()
        }
    }

    private val voiceSearch: OfflineVoiceSearchController by lazy {
        OfflineVoiceSearchController(
            this,
            onStatus = { status, listening -> youtubeContent.setVoiceSearchStatus(status, listening) },
            onTranscript = { query ->
                if (resumed && modeController.mode == ArcadeMode.YouTube &&
                    youtubeContent.session.state.active && youtubeContent.session.state.screen == Screen.Results &&
                    !youtubeContent.session.hasEngine
                ) {
                    youtubeContent.acceptVoiceSearchResult(query)
                }
            },
            onFailure = { detail ->
                if (resumed && modeController.mode == ArcadeMode.YouTube) {
                    Toast.makeText(this, detail, Toast.LENGTH_LONG).show()
                }
            },
        )
    }

    private val refresh = object : Runnable {
        override fun run() {
            applyState()
            handler.postDelayed(this, REFRESH_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        UvcProcess.acquire(this, this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(buildUi())
        queueYouTubeImport(intent)
        startBridgeService()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        queueYouTubeImport(intent)
        startBridgeService()
    }

    override fun onResume() {
        super.onResume()
        controllerOwnership.onHostResume()
        appliedBrightnessRevision = -1
        applyStoredBrightness()
        bindHttpEndpoint(force = true)
        handler.removeCallbacks(refresh)
        handler.post(refresh)
        modeController.onHostResume()
        resumed = true
        processYouTubeImport()
    }

    override fun onPause() {
        voiceSearch.cancel()
        controllerOwnership.onHostPause()
        gameController.resetTransient()
        resumed = false
        modeController.onHostPause()
        mediaLifecycle.afterHostPause()
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    private fun requestYouTubeVoiceSearch() {
        if (!resumed || modeController.mode != ArcadeMode.YouTube) return
        if (!youtubeContent.session.state.active || youtubeContent.session.state.screen != Screen.Results) return
        if (youtubeContent.session.hasEngine) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), YOUTUBE_VOICE_PERMISSION_REQUEST)
            return
        }
        voiceSearch.toggle()
    }

    private fun queueYouTubeImport(intent: Intent?) {
        if (intent?.action != YouTubeCredentialsImport.ACTION) return
        pendingYouTubeImport = intent.getStringExtra(YouTubeCredentialsImport.EXTRA_NONCE)
        processYouTubeImport()
    }

    private fun processYouTubeImport() {
        if (!resumed) return
        val nonce = pendingYouTubeImport ?: return
        pendingYouTubeImport = null
        if (!YouTubeCredentialsImport.validNonce(nonce)) return
        modeController.select(ArcadeMode.YouTube)
        youtubeContent.importGoogleCredentials(nonce)
    }

    override fun onDestroy() {
        voiceSearch.cancel()
        controllerOwnership.onHostPause()
        modeController.onHostDestroy()
        mediaLifecycle.afterHostDestroy()
        handler.removeCallbacks(refresh)
        UvcProcess.release(this)
        super.onDestroy()
    }

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (::booksContent.isInitialized && modeController.mode == ArcadeMode.Books && booksContent.exitReadingFullscreen()) return
        super.onBackPressed()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (ControllerDevices.belongsToController(event.device)) {
            if (exclusiveHid.isActive() && exclusiveHid.belongsTo(event.device)) exclusiveHid.noteAndroidEvent()
            gameController.refresh()
            val mode = modeController.mode
            val selected = ControllerDevices.chosen(
                ControllerDevices.visible(),
                getSharedPreferences(ControllerDevices.PREFS, Context.MODE_PRIVATE)
                    .getString(ControllerDevices.SELECTED, null),
            )
            val matches = selected != null && event.device != null &&
                selected.vendorId == event.device.vendorId && selected.productId == event.device.productId
            val controllerEnabled = when (mode) {
                ArcadeMode.Bricks -> arcadeContent.playground.inputSource == BricksInputSource.Controller
                ArcadeMode.Flak -> arcadeContent.flak.inputSource == FlakInputSource.Controller
                ArcadeMode.Biketris -> arcadeContent.biketris.inputSource != BiketrisInputSource.Webcam
                ArcadeMode.GhoulRun -> arcadeContent.ghoul.inputSource != GhoulRunInputSource.Webcam
                else -> true
            }
            val action = if (mode.isGame && modeController.isActive && matches && controllerEnabled) {
                gameBindings.action(mode, selected!!.descriptor, event.keyCode)?.id
            } else null
            if (action != null && event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                performMappedGameAction(mode, action)
            }
            gameController.handleKey(
                event,
                steerBricks = modeController.isActive && controllerEnabled &&
                    (mode == ArcadeMode.Bricks || mode == ArcadeMode.Biketris ||
                        mode == ArcadeMode.GhoulRun || mode == ArcadeMode.Flak),
                mappedAction = action,
            )
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun performMappedGameAction(mode: ArcadeMode, action: String) {
        when (action) {
            "restart" -> when (mode) {
                ArcadeMode.Math -> arcadeContent.math.restartGame()
                ArcadeMode.Flak -> arcadeContent.flak.restartGame()
                ArcadeMode.TrailRide -> arcadeContent.trail.restartGame()
                ArcadeMode.GhoulRun -> arcadeContent.ghoul.restartGame()
                ArcadeMode.Biketris -> arcadeContent.biketris.restartGame()
                else -> Unit
            }
        }
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        if (com.fitbaus.bikebridge.host.controller.ControllerDevices.belongsToController(event.device)) {
            gameController.refresh()
            if (modeController.isActive && (
                modeController.mode == ArcadeMode.Bricks &&
                    arcadeContent.playground.inputSource == BricksInputSource.Controller ||
                modeController.mode == ArcadeMode.Flak &&
                    arcadeContent.flak.inputSource == FlakInputSource.Controller ||
                modeController.mode == ArcadeMode.Biketris &&
                    arcadeContent.biketris.inputSource != BiketrisInputSource.Webcam
                    || modeController.mode == ArcadeMode.GhoulRun &&
                    arcadeContent.ghoul.inputSource != GhoulRunInputSource.Webcam
            )) gameController.handleMotion(event)
            return true
        }
        return super.dispatchGenericMotionEvent(event)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.isFromSource(android.view.InputDevice.SOURCE_MOUSE) &&
            com.fitbaus.bikebridge.host.controller.ControllerDevices.belongsToController(event.device)
        ) return true
        return super.dispatchTouchEvent(event)
    }

    @Suppress("DEPRECATION")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            CAMERA_PERMISSION_REQUEST -> {
                val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
                cameraSession.onPermissionResult(granted)
            }
            YOUTUBE_VOICE_PERMISSION_REQUEST -> {
                if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                    requestYouTubeVoiceSearch()
                } else {
                    Toast.makeText(this, "Microphone permission is required for voice search.", Toast.LENGTH_LONG).show()
                }
            }
        }
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
        val heartRate = BridgeProcess.heartRate().view()
        dashboardContent.bind(state, telemetry, heartRate)
        val mediaHud = when (modeController.mode) {
            ArcadeMode.YouTube -> youtubeContent.hud
            ArcadeMode.Books -> booksContent.hud
            else -> null
        }
        if (mediaHud != null) {
            mediaHud.bind(
                BridgeUiStateMapper.currentValue(telemetry?.rpm),
                BridgeUiStateMapper.currentValue(telemetry?.watts),
                BridgeUiStateMapper.currentValue(telemetry?.resistance),
                heartRate?.bpm,
                heartRate?.fresh == true,
            )
        }
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
            gameController.refresh()
            arcadeContent.flak.controllerAvailable = gameController.hasController()
            val controllerOnly = arcadeContent.flak.inputSource == FlakInputSource.Controller
            arcadeContent.flak.render(
                if (controllerOnly) HandPosition(0.5f, 0.5f, 0f, now, HandSource.Lost) else handInput.latest(now),
                cameraSession.state(),
                cameraSession.failureReason(),
                connected = telemetry?.connected == true,
                initialized = telemetry?.initialized == true,
                rpm = telemetry?.rpm?.value,
                rpmCurrent = telemetry?.rpm?.current == true,
                rpmObservedAt = telemetry?.rpm?.observedAt,
                diagnostics = arcadeDiagnosticsText(now, info),
                cameraInfo = if (controllerOnly) null else info,
                controller = if (controllerOnly) gameController.takeFlakInput() else null,
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
        if (modeController.mode == ArcadeMode.GhoulRun) {
            gameController.refresh()
            arcadeContent.ghoul.controllerAvailable = gameController.hasController()
            val source = arcadeContent.ghoul.inputSource
            val controllerOnly = source == GhoulRunInputSource.Controller
            val ghoulDescriptor = gameController.selectedDescriptor()
            val reverseFromHat = ghoulDescriptor?.let { descriptor ->
                gameBindings.action(ArcadeMode.GhoulRun, descriptor, KeyEvent.KEYCODE_DPAD_DOWN)?.id == "reverse"
            } == true
            val leftFromHat = ghoulDescriptor?.let { descriptor ->
                gameBindings.action(ArcadeMode.GhoulRun, descriptor, KeyEvent.KEYCODE_DPAD_LEFT)?.id == "left"
            } == true
            val rightFromHat = ghoulDescriptor?.let { descriptor ->
                gameBindings.action(ArcadeMode.GhoulRun, descriptor, KeyEvent.KEYCODE_DPAD_RIGHT)?.id == "right"
            } == true
            arcadeContent.ghoul.render(
                if (controllerOnly) HandPosition(0.5f, 0.5f, 0f, now, HandSource.Lost) else handInput.latest(now),
                cameraSession.state(),
                cameraSession.failureReason(),
                connected = telemetry?.connected == true,
                initialized = telemetry?.initialized == true,
                rpm = telemetry?.rpm?.value,
                rpmCurrent = telemetry?.rpm?.current == true,
                rpmObservedAt = telemetry?.rpm?.observedAt,
                diagnostics = arcadeDiagnosticsText(now, info),
                cameraInfo = if (controllerOnly) null else info,
                controller = if (source == GhoulRunInputSource.Webcam) null else gameController.takeGhoulRunInput(reverseFromHat, leftFromHat, rightFromHat),
            )
            return
        }
        if (modeController.mode == ArcadeMode.Biketris) {
            if (exclusiveHid.isActive()) controllerOwnership.refreshNow()
            gameController.refresh()
            arcadeContent.biketris.controllerAvailable = gameController.hasController()
            val source = arcadeContent.biketris.inputSource
            val usingController = source != BiketrisInputSource.Webcam
            val controllerOnly = source == BiketrisInputSource.Controller
            val gamepadInput = if (usingController) gameController.takeBiketrisInput() else null
            arcadeContent.biketris.render(
                if (controllerOnly) HandPosition(0.5f, 0.5f, 0f, now, HandSource.Lost)
                else handInput.latest(now),
                cameraSession.state(),
                cameraSession.failureReason(),
                connected = telemetry?.connected == true,
                initialized = telemetry?.initialized == true,
                rpm = telemetry?.rpm?.value,
                rpmCurrent = telemetry?.rpm?.current == true,
                rpmObservedAt = telemetry?.rpm?.observedAt,
                diagnostics = arcadeDiagnosticsText(now, info),
                cameraInfo = if (controllerOnly) null else info,
                controller = gamepadInput,
            )
            return
        }
        gameController.refresh()
        arcadeContent.playground.controllerAvailable = gameController.hasController() || exclusiveHid.isActive()
        val source = arcadeContent.playground.inputSource
        val touch = if (handInput.isTouching()) handInput.latest(now) else null
        val controllerPosition = if (source == BricksInputSource.Controller && touch == null) {
            if (exclusiveHid.isActive()) exclusiveHid.sampleBricks(now) else gameController.sample(now)
        } else null
        val frame = BricksInputRouting.resolve(
            source = source,
            nowNanos = now,
            touch = touch,
            controller = controllerPosition,
            camera = { handInput.latest(now) },
            cameraStatus = {
                ArcadeStatusResolver.resolve(
                    cameraSession.state(),
                    handInput.cameraTracking(now),
                    handInput.hasEverTracked(),
                )
            },
        )
        arcadeContent.playground.render(frame.position, frame.status, arcadeDiagnosticsText(now, info),
            if (source == BricksInputSource.Webcam) info else null,
        )
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
        if (mode != ArcadeMode.Books) booksContent.leaveFullscreen()
        handInput.immediateFaceLoss = mode == ArcadeMode.TrailRide
        dashboardContent.visibility = if (mode == ArcadeMode.Dashboard) View.VISIBLE else View.GONE
        arcadeContent.visibility = if (mode.isGame) View.VISIBLE else View.GONE
        youtubeContent.visibility = if (mode == ArcadeMode.YouTube) View.VISIBLE else View.GONE
        booksContent.visibility = if (mode == ArcadeMode.Books) View.VISIBLE else View.GONE
        arcadeContent.show(mode)
        navigationHeader.render(mode)
    }

    private fun bindHttpEndpoint(force: Boolean) {
        if (!::dashboardContent.isInitialized) return
        val service = NativeBridgeService.instance
        dashboardContent.bindHttpEndpoint(force, service?.isHttpListening(), service?.httpError())
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

    private fun systemBrightnessPercent(): Int = try {
        Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS) * 100 / 255
    } catch (_: Settings.SettingNotFoundException) {
        50
    }

    private fun buildUi(): View {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setBackgroundColor(BACKGROUND)
        val pad = dp(16)
        root.setPadding(pad, dp(10), pad, dp(10))

        navigationHeader = BridgeNavigationHeader(
            this,
            onSelectMode = modeController::select,
            onOpenSettings = ::openPairingSettings,
            onTrackerPicker = { trackerPicker.show(it) },
        )
        val titleRow = navigationHeader.view
        root.addView(titleRow)

        val contentHost = FrameLayout(this)
        dashboardContent = BridgeDashboardView(this)
        contentHost.addView(
            dashboardContent,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        arcadeContent = ArcadeContent(this)
        arcadeContent.playground.onInputSourceChanged = { gameController.resetTransient() }
        arcadeContent.biketris.onInputSourceChanged = { gameController.resetTransient() }
        arcadeContent.flak.onInputSourceChanged = { gameController.resetTransient() }
        arcadeContent.ghoul.onInputSourceChanged = { gameController.resetTransient() }
        arcadeContent.playground.input = handInput
        arcadeContent.playground.preview = cameraSession.preview
        arcadeContent.playground.faceControl = arcadeConfiguration.settingsFor(ArcadeMode.Bricks).mode == ArcadeTrackerMode.Face
        arcadeContent.math.fingers = cameraSession.fingers
        arcadeContent.math.preview = cameraSession.preview
        arcadeContent.biketris.gestures = cameraSession.gestures
        arcadeContent.applyDiagnosticsOverlay(arcadeConfiguration.diagnosticsOverlay())
        contentHost.addView(
            arcadeContent,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        youtubeContent = YouTubeContent(
            this,
            getSharedPreferences(YouTubeContent.PREFS, Context.MODE_PRIVATE),
            youtubeBrightness,
            onRestoreRequested = { modeController.select(ArcadeMode.YouTube) },
            onVoiceSearchRequested = { requestYouTubeVoiceSearch() },
            onVoiceSearchCancelled = { voiceSearch.cancel() },
        )
        contentHost.addView(
            youtubeContent,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        booksContent = BooksContent(
            this,
            onRestoreRequested = { modeController.select(ArcadeMode.Books) },
            onReadingFullscreenChanged = { fullscreen ->
                titleRow.visibility = if (fullscreen) View.GONE else View.VISIBLE
                root.setPadding(if (fullscreen) 0 else pad, if (fullscreen) 0 else dp(10),
                    if (fullscreen) 0 else pad, if (fullscreen) 0 else dp(10))
            },
        )
        contentHost.addView(
            booksContent,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        contentHost.addView(booksContent.floatingPlayer, FrameLayout.LayoutParams(dp(360), dp(220), Gravity.TOP or Gravity.END))
        floatingPlayer = buildFloatingPlayer()
        contentHost.addView(
            floatingPlayer,
            FrameLayout.LayoutParams(dp(296), dp(167), Gravity.TOP or Gravity.END).apply {
                topMargin = dp(12)
                rightMargin = dp(12)
            },
        )
        root.addView(contentHost, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        showContent(modeController.mode)
        applyState()
        return root
    }

    private fun buildFloatingPlayer(): FrameLayout {
        val floating = FrameLayout(this)
        floating.setBackgroundColor(Color.BLACK)
        floating.elevation = dp(12).toFloat()
        floating.visibility = View.GONE

        floatingVideoSlot = FrameLayout(this)
        floatingVideoSlot.setBackgroundColor(Color.BLACK)
        floating.addView(
            floatingVideoSlot,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )

        val close = label("×", 28f, PRIMARY)
        close.gravity = Gravity.CENTER
        close.contentDescription = "Close YouTube floating player"
        close.isClickable = true
        close.isFocusable = true
        close.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.argb(195, 0, 0, 0))
        }
        close.setOnClickListener { mediaLifecycle.closeYouTubeFloating() }
        floating.addView(
            close,
            FrameLayout.LayoutParams(dp(48), dp(48), Gravity.TOP or Gravity.END).apply {
                topMargin = dp(6)
                rightMargin = dp(6)
            },
        )
        return floating
    }

    private fun openPairingSettings() {
        val intent = Intent(this, PairingActivity::class.java)
        if (modeController.mode.isGame) intent.putExtra(CONTROLLER_GAME_CONTEXT, modeController.mode.name)
        startActivity(intent)
    }

    private fun setDiagnosticsOverlay(enabled: Boolean) {
        arcadeConfiguration.saveDiagnosticsOverlay(enabled)
        arcadeContent.applyDiagnosticsOverlay(enabled)
    }

    private fun applyTrackerSettings(game: ArcadeMode, next: ArcadeTrackerSettings) {
        arcadeLifecycle.applyTrackerSettings(game, modeController.mode, modeController.isActive, next)
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
        const val CAMERA_PERMISSION_REQUEST = 4101
        const val YOUTUBE_VOICE_PERMISSION_REQUEST = 4103
        val BACKGROUND: Int = Color.BLACK
        val PRIMARY: Int = Color.WHITE
    }
}
