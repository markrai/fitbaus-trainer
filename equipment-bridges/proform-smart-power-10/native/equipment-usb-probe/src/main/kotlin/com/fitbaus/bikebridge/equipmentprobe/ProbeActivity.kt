// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Button
import android.widget.TextView
import com.fitbaus.bikebridge.equipmentprobe.session.ProbePhase
import com.fitbaus.bikebridge.equipmentprobe.session.ProbeSessionRunner
import com.fitbaus.bikebridge.equipmentprobe.session.SessionReport
import com.fitbaus.bikebridge.equipmentprobe.session.StageCoordinator
import com.fitbaus.bikebridge.equipmentprobe.session.StopKind
import com.fitbaus.bikebridge.equipmentprobe.usb.AndroidUsbHostGateway
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualificationResult
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class ProbeActivity : Activity() {
    private lateinit var identityText: TextView
    private lateinit var usbStatusText: TextView
    private lateinit var qualificationText: TextView
    private lateinit var permissionText: TextView
    private lateinit var stageStatusText: TextView
    private lateinit var outcomeText: TextView
    private lateinit var reportText: TextView
    private lateinit var runBasicButton: Button
    private lateinit var runDynamicButton: Button
    private lateinit var stageStartButton: Button
    private lateinit var stageEndButton: Button
    private lateinit var stageFinishButton: Button
    private lateinit var runExtendedButton: Button

    private val mainHandler = Handler(Looper.getMainLooper())
    private var worker: ExecutorService? = null
    private val sessionActive = AtomicBoolean(false)
    private val cancelFlag = AtomicBoolean(false)
    private var autoRunConsumed = false
    private var pendingInitialStage: String? = null
    private var pendingDurationMs: Long = ProbeConstants.DYNAMIC_DURATION_MS
    private var plannedStages: List<String> = DEFAULT_STAGES
    private var plannedIndex = 0
    private var activeStageCoordinator: StageCoordinator? = null
    private val permissionGeneration = AtomicInteger(0)
    private var permissionLatch: CountDownLatch? = null
    private var permissionGranted: Boolean = false
    private var permissionExpectGeneration: Int = -1
    private var permissionExpectDeviceName: String? = null
    private var receiverRegistered = false
    private var sessionRunner: ProbeSessionRunner? = null

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ProbeConstants.USB_PERMISSION_ACTION -> {
                    val device = usbDeviceExtra(intent)
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    val expected = permissionExpectDeviceName
                    val generationMatches = permissionExpectGeneration == permissionGeneration.get()
                    val deviceMatches = expected != null && device?.deviceName == expected
                    if (generationMatches && deviceMatches) {
                        permissionGranted = granted
                        permissionLatch?.countDown()
                    }
                    refreshPassiveStatus()
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> refreshPassiveStatus()
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    sessionRunner?.clearExtendedEligibility("USB device detached")
                    cancelFlag.set(true)
                    refreshPassiveStatus()
                }
                ACTION_STAGE_SIGNAL -> handleStageBroadcast(intent)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_probe)
        identityText = findViewById(R.id.identityText)
        usbStatusText = findViewById(R.id.usbStatusText)
        qualificationText = findViewById(R.id.qualificationText)
        permissionText = findViewById(R.id.permissionText)
        stageStatusText = findViewById(R.id.stageStatusText)
        outcomeText = findViewById(R.id.outcomeText)
        reportText = findViewById(R.id.reportText)
        runBasicButton = findViewById(R.id.runBasicButton)
        runDynamicButton = findViewById(R.id.runDynamicButton)
        stageStartButton = findViewById(R.id.stageStartButton)
        stageEndButton = findViewById(R.id.stageEndButton)
        stageFinishButton = findViewById(R.id.stageFinishButton)
        runExtendedButton = findViewById(R.id.runExtendedButton)

        val versionName = try {
            packageManager.getPackageInfo(packageName, 0).versionName
        } catch (_: Exception) {
            "unknown"
        }
        identityText.text = getString(R.string.app_name) + "\n" + packageName + "\nv" + versionName

        consumeLaunchExtras(intent)

        runBasicButton.setOnClickListener { startBasic() }
        runDynamicButton.setOnClickListener { startDynamic(pendingDurationMs) }
        stageStartButton.setOnClickListener { startNextPlannedStage() }
        stageEndButton.setOnClickListener {
            activeStageCoordinator?.requestEnd()
            refreshStageStatus()
        }
        stageFinishButton.setOnClickListener {
            activeStageCoordinator?.requestFinishSession()
            refreshStageStatus()
        }
        runExtendedButton.setOnClickListener { startExtended() }
        runExtendedButton.isEnabled = false

        outcomeText.text = getString(R.string.outcome_label) + ": idle (no automatic probe)"
        reportText.text = getString(R.string.report_label) + ": none yet"
        refreshStageStatus()
        Log.i(ProbeConstants.LOG_TAG, "activity created; waiting for operator action")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        autoRunConsumed = false
        consumeLaunchExtras(intent)
        maybeAutoRunDynamic()
    }

    override fun onStart() {
        super.onStart()
        if (!receiverRegistered) {
            val filter = IntentFilter().apply {
                addAction(ProbeConstants.USB_PERMISSION_ACTION)
                addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
                addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
                addAction(ACTION_STAGE_SIGNAL)
            }
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(usbReceiver, filter, RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(usbReceiver, filter)
            }
            receiverRegistered = true
        }
        refreshPassiveStatus()
        maybeAutoRunDynamic()
    }

    override fun onStop() {
        cancelFlag.set(true)
        abortPermissionWait()
        if (receiverRegistered) {
            try {
                unregisterReceiver(usbReceiver)
            } catch (_: Exception) {
            }
            receiverRegistered = false
        }
        super.onStop()
    }

    override fun onDestroy() {
        cancelFlag.set(true)
        abortPermissionWait()
        shutdownWorker()
        sessionRunner?.clearExtendedEligibility("activity destroyed")
        super.onDestroy()
    }

    private fun refreshPassiveStatus() {
        val runner = ensureRunner()
        runner.refreshExtendedEligibility()
        val status = runner.passiveStatus()
        usbStatusText.text = getString(R.string.usb_status_label) + ": devices=" + status.deviceCount
        qualificationText.text = getString(R.string.qualification_label) + ": " + when (val q = status.qualification) {
            is UsbQualificationResult.Qualified -> "qualified (" + q.device.deviceName + ")"
            is UsbQualificationResult.Rejected -> "rejected: " + q.reason
        }
        permissionText.text = getString(R.string.permission_label) + ": " + when (status.permissionGranted) {
            null -> "n/a"
            true -> "granted"
            false -> "not granted"
        }
        updateButtons()
        refreshStageStatus()
    }

    private fun consumeLaunchExtras(intent: Intent?) {
        if (intent == null) return
        pendingInitialStage = StageCoordinator.normalize(intent.getStringExtra(EXTRA_STAGE))
        val duration = intent.getLongExtra(EXTRA_DURATION_MS, ProbeConstants.DYNAMIC_DURATION_MS)
        pendingDurationMs = ProbeConstants.clampDynamicDurationMs(duration)
        val csv = intent.getStringExtra(EXTRA_STAGES)
        if (!csv.isNullOrBlank()) {
            plannedStages = csv.split(',')
                .mapNotNull { StageCoordinator.normalize(it) }
                .ifEmpty { DEFAULT_STAGES }
        }
    }

    private fun maybeAutoRunDynamic() {
        if (autoRunConsumed) return
        val intent = intent ?: return
        val auto = intent.getStringExtra(EXTRA_AUTO_RUN)
        if (!auto.equals("dynamic", ignoreCase = true)) return
        autoRunConsumed = true
        Log.i(
            ProbeConstants.LOG_TAG,
            "auto_run=dynamic initialStage=$pendingInitialStage durationMs=$pendingDurationMs",
        )
        startDynamic(pendingDurationMs)
    }

    private fun handleStageBroadcast(intent: Intent) {
        val coordinator = activeStageCoordinator ?: return
        val action = intent.getStringExtra(EXTRA_STAGE_ACTION)?.lowercase()
        val name = StageCoordinator.normalize(intent.getStringExtra(EXTRA_STAGE_NAME))
        when (action) {
            "start" -> if (name != null) coordinator.requestStart(name)
            "end" -> coordinator.requestEnd()
            "finish" -> coordinator.requestFinishSession()
        }
        refreshStageStatus()
    }

    private fun startNextPlannedStage() {
        val coordinator = activeStageCoordinator ?: return
        if (plannedIndex >= plannedStages.size) {
            stageStatusText.text = getString(R.string.stage_status_label) +
                ": no more planned stages (use Finish)"
            return
        }
        val next = plannedStages[plannedIndex]
        plannedIndex += 1
        coordinator.requestStart(next)
        refreshStageStatus()
    }

    private fun refreshStageStatus() {
        val active = activeStageCoordinator?.activeStage()
        val next = plannedStages.getOrNull(plannedIndex)
        stageStatusText.text = getString(R.string.stage_status_label) +
            ": active=${active ?: "none"} next=${next ?: "none"} " +
            "planned=${plannedStages.joinToString(",")}"
    }

    private fun startBasic() {
        if (!sessionActive.compareAndSet(false, true)) return
        cancelFlag.set(false)
        activeStageCoordinator = null
        updateButtons()
        outcomeText.text = getString(R.string.outcome_label) + ": running basic probe…"
        val executor = Executors.newSingleThreadExecutor()
        worker = executor
        executor.execute {
            val report = try {
                ensureRunner().runBasic { cancelFlag.get() }
            } catch (_: Exception) {
                SessionReport(
                    phase = ProbePhase.BASIC,
                    outcome = "worker failure",
                    stopKind = StopKind.TRANSPORT_FAILURE,
                    identityQualified = false,
                    telemetryQualified = false,
                    reportFile = null,
                    events = emptyList(),
                )
            }
            mainHandler.post {
                applyReport(report)
                sessionActive.set(false)
                shutdownWorker()
                updateButtons()
                refreshPassiveStatus()
            }
        }
    }

    private fun startDynamic(durationMs: Long) {
        if (!sessionActive.compareAndSet(false, true)) return
        cancelFlag.set(false)
        plannedIndex = 0
        val coordinator = StageCoordinator()
        activeStageCoordinator = coordinator
        // Prefer explicit initial stage; else first planned stage is started by operator.
        val initial = pendingInitialStage
        updateButtons()
        refreshStageStatus()
        outcomeText.text = getString(R.string.outcome_label) +
            ": running dynamic observation (multi-stage)…"
        val executor = Executors.newSingleThreadExecutor()
        worker = executor
        executor.execute {
            val report = try {
                ensureRunner().runDynamic(
                    isCancelled = { cancelFlag.get() },
                    stageCoordinator = coordinator,
                    initialStage = initial,
                    durationMs = durationMs,
                )
            } catch (_: Exception) {
                SessionReport(
                    phase = ProbePhase.DYNAMIC,
                    outcome = "worker failure",
                    stopKind = StopKind.TRANSPORT_FAILURE,
                    identityQualified = false,
                    telemetryQualified = false,
                    reportFile = null,
                    events = emptyList(),
                )
            }
            mainHandler.post {
                applyReport(report)
                activeStageCoordinator = null
                sessionActive.set(false)
                shutdownWorker()
                updateButtons()
                refreshPassiveStatus()
            }
        }
    }

    private fun startExtended() {
        val runner = ensureRunner()
        runner.refreshExtendedEligibility()
        if (!runner.extendedQualification.eligible) {
            outcomeText.text = getString(R.string.outcome_label) + ": extended not authorized"
            updateButtons()
            return
        }
        if (!sessionActive.compareAndSet(false, true)) return
        cancelFlag.set(false)
        updateButtons()
        outcomeText.text = getString(R.string.outcome_label) + ": running extended observation…"
        val executor = Executors.newSingleThreadExecutor()
        worker = executor
        executor.execute {
            val report = try {
                ensureRunner().runExtended { cancelFlag.get() }
            } catch (_: Exception) {
                SessionReport(
                    phase = ProbePhase.EXTENDED,
                    outcome = "worker failure",
                    stopKind = StopKind.TRANSPORT_FAILURE,
                    identityQualified = false,
                    telemetryQualified = false,
                    reportFile = null,
                    events = emptyList(),
                )
            }
            mainHandler.post {
                applyReport(report)
                sessionActive.set(false)
                shutdownWorker()
                updateButtons()
                refreshPassiveStatus()
            }
        }
    }

    private fun ensureRunner(): ProbeSessionRunner {
        val existing = sessionRunner
        if (existing != null) return existing
        val usbManager = getSystemService(USB_SERVICE) as UsbManager
        val gateway = AndroidUsbHostGateway(usbManager)
        val created = ProbeSessionRunner(gateway, reportsDir()) { deviceName ->
            requestUsbPermissionBlocking(usbManager, deviceName)
        }
        sessionRunner = created
        return created
    }

    private fun requestUsbPermissionBlocking(usbManager: UsbManager, deviceName: String): Boolean {
        val device = gatewayDevice(usbManager, deviceName) ?: return false
        if (usbManager.hasPermission(device)) return true
        val generation = permissionGeneration.incrementAndGet()
        permissionGranted = false
        permissionExpectGeneration = generation
        permissionExpectDeviceName = deviceName
        permissionLatch = CountDownLatch(1)
        val intent = Intent(ProbeConstants.USB_PERMISSION_ACTION).setPackage(packageName)
        val pending = PendingIntent.getBroadcast(this, 0, intent, usbPermissionPendingIntentFlags())
        usbManager.requestPermission(device, pending)
        val completed = try {
            permissionLatch?.await(60, TimeUnit.SECONDS) == true
        } catch (_: InterruptedException) {
            false
        }
        val accepted = completed &&
            permissionExpectGeneration == generation &&
            permissionExpectDeviceName == deviceName &&
            permissionGranted
        if (permissionExpectGeneration == generation) {
            permissionLatch = null
            permissionExpectDeviceName = null
            permissionExpectGeneration = -1
        }
        return accepted && usbManager.hasPermission(device)
    }

    private fun usbPermissionPendingIntentFlags(): Int {
        return if (Build.VERSION.SDK_INT >= 31) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
    }

    private fun abortPermissionWait() {
        permissionGeneration.incrementAndGet()
        permissionGranted = false
        permissionLatch?.countDown()
        permissionLatch = null
        permissionExpectDeviceName = null
        permissionExpectGeneration = -1
    }

    private fun usbDeviceExtra(intent: Intent): UsbDevice? {
        return if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE) as UsbDevice?
        }
    }

    private fun gatewayDevice(usbManager: UsbManager, deviceName: String) =
        usbManager.deviceList.values.firstOrNull { it.deviceName == deviceName }

    private fun applyReport(report: SessionReport) {
        outcomeText.text = getString(R.string.outcome_label) + ": " + report.outcome +
            " [" + report.stopKind + "]"
        reportText.text = getString(R.string.report_label) + ": " +
            (report.reportFile?.absolutePath ?: "write failed")
        Log.i(ProbeConstants.LOG_TAG, "phase=${report.phase} outcome=${report.outcome} stop=${report.stopKind}")
    }

    private fun updateButtons() {
        val busy = sessionActive.get()
        val dynamicBusy = busy && activeStageCoordinator != null
        val eligible = sessionRunner?.extendedQualification?.eligible == true
        runBasicButton.isEnabled = !busy
        runDynamicButton.isEnabled = !busy
        stageStartButton.isEnabled = dynamicBusy
        stageEndButton.isEnabled = dynamicBusy
        stageFinishButton.isEnabled = dynamicBusy
        runExtendedButton.isEnabled = !busy && eligible
    }

    private fun shutdownWorker() {
        worker?.shutdownNow()
        worker = null
    }

    private fun reportsDir() = getExternalFilesDir(null) ?: filesDir

    companion object {
        const val EXTRA_AUTO_RUN: String = "auto_run"
        const val EXTRA_STAGE: String = "stage"
        const val EXTRA_STAGES: String = "stages"
        const val EXTRA_DURATION_MS: String = "duration_ms"
        const val ACTION_STAGE_SIGNAL: String = "com.fitbaus.bikebridge.equipmentprobe.STAGE"
        const val EXTRA_STAGE_ACTION: String = "action"
        const val EXTRA_STAGE_NAME: String = "name"

        val DEFAULT_STAGES: List<String> = listOf(
            "idle",
            "cadence-1",
            "cadence-2",
            "cadence-3",
            "resistance-key-1",
            "resistance-key-2",
            "resistance-key-3",
        )
    }
}
