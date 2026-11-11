// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.app.Activity
import java.util.Locale
import kotlin.math.abs

public enum class ArcadeStopReason { ExitArcade, HostPaused, HostDestroyed }

internal interface CameraPermissionGate {
    fun isGranted(): Boolean

    /** True when a runtime request is possible (API 23+). API 22 grants CAMERA at install time. */
    fun canRequest(): Boolean
    fun request()
}

/** Callbacks may arrive on the camera thread. */
internal interface FrameSourceListener {
    fun onCameraReady(width: Int, height: Int, frontFacing: Boolean)
    fun onCameraFailed(reason: String)
}

internal interface FrameSource {
    fun start(listener: FrameSourceListener)

    /** Idempotent; releases the camera. */
    fun stop()
}

public data class ArcadeCameraInfo(
    public val width: Int,
    public val height: Int,
    public val frontFacing: Boolean,
    public val processedFrames: Long,
    public val trackerMicros: Long,
    public val diagnostics: ArcadeTrackerDiagnostics,
) {
    public fun summary(trackerLabel: String): String {
        val d = diagnostics
        val camera = String.format(Locale.US, "%dx%d %s", width, height, if (frontFacing) "front" else "rear")
        val cpu = if (d.processCpuPercent.isNaN()) "-" else String.format(Locale.US, "%.0f%%", d.processCpuPercent)
        if (d.mode == ArcadeTrackerMode.Classical) {
            return String.format(
                Locale.US,
                "Classical  %s  %.0f Hz  %.1f ms  p90 %.1f ms  lost %d  cpu %s",
                camera,
                d.processedHz,
                trackerMicros / 1000f,
                d.processingP90Ms,
                d.trackingLosses,
                cpu,
            )
        }
        d.lastError?.let { return it }
        if (d.mode == ArcadeTrackerMode.Fingers) {
            return String.format(
                Locale.US,
                "%s  %.1f Hz  update p50 %.0f / p90 %.0f ms  infer %.0f ms  age %.0f ms  skipped %d  hand losses %d  cpu %s",
                trackerLabel,
                d.processedHz,
                d.processingP50Ms,
                d.processingP90Ms,
                d.inferenceP50Ms,
                d.frameAgeP50Ms,
                d.framesSuperseded,
                d.trackingLosses,
                cpu,
            )
        }
        return String.format(
            Locale.US,
            "%s  %.1f Hz  track %d: %.0f/%.0f ms (infer %.0f)  search %d: %.0f ms (infer %.0f)  age %.0f ms  skipped %d  " +
                "lost %d [presence %d region %d jump %d hand %d err %d]  reacq %d  cpu %s",
            trackerLabel,
            d.processedHz,
            d.trackUpdates,
            d.trackP50Ms,
            d.trackP90Ms,
            d.trackInferenceP50Ms,
            d.searchUpdates,
            d.searchP50Ms,
            d.searchInferenceP50Ms,
            d.frameAgeP50Ms,
            d.framesSuperseded,
            d.trackingLosses,
            d.lossPresence,
            d.lossRegion,
            d.lossWristJump,
            d.lossHandedness,
            d.lossBackend,
            d.reacquisitions,
            cpu,
        )
    }
}

/**
 * Camera permission + open/close lifecycle for the Arcade. UI-thread API ([start], [stop],
 * [onPermissionResult]); source callbacks may come from the camera thread. Every start uses a
 * fresh tracker, so leaving the Arcade clears all tracking state.
 */
public class ArcadeCameraSession internal constructor(
    private val permission: CameraPermissionGate,
    private val input: HandPositionInput,
    private val trackerConfig: TrackerConfig = TrackerConfig(),
    private val processEvery: Int = 1,
    initialSettings: ArcadeTrackerSettings = ArcadeTrackerSettings.CLASSICAL,
    private val landmarkBackendFactory: ((ArcadeTrackerSettings) -> HandModelBackend)? = null,
    private val cpuClockMs: () -> Long = { android.os.Process.getElapsedCpuTime() },
    private val wallClockNanos: () -> Long = { System.nanoTime() },
    private val nativeGate: NativeSessionGate = NativeSessionGate.SHARED,
    private val sourceFactory: (FrameConsumer) -> FrameSource,
) {
    private class Preview(val width: Int, val height: Int, val frontFacing: Boolean)

    @Volatile
    private var state: CameraState = CameraState.Off

    @Volatile
    private var source: FrameSource? = null

    @Volatile
    private var sink: FrameConsumer? = null

    @Volatile
    public var settings: ArcadeTrackerSettings = initialSettings
        private set

    private val rate = RateMeter()
    private var cpuStartMs = -1L
    private var cpuStartNanos = 0L
    private var cpuPercent = Float.NaN

    @Volatile
    private var previewSize: Preview? = null

    @Volatile
    private var failure: String? = null
    private var wanted = false
    private var requestPending = false
    private var denied = false

    public val preview: ArcadePreview = ArcadePreview()

    public val fingers: FingerCountInput = FingerCountInput()

    public fun state(): CameraState {
        val current = state
        if (current == CameraState.Ready && sink?.failure != null) return CameraState.Unavailable
        return current
    }

    public fun failureReason(): String? = sink?.failure ?: failure

    public fun updateSettings(next: ArcadeTrackerSettings) {
        settings = next
    }

    public fun info(): ArcadeCameraInfo? {
        val p = previewSize ?: return null
        val s = sink ?: return null
        if (state != CameraState.Ready) return null
        val stats = s.stats()
        val now = wallClockNanos()
        rate.update(stats.processedFrames, now)
        sampleCpu(now)
        val micros = (s as? TrackingFrameSink)?.lastTrackerMicros ?: (stats.processingP50Ms * 1000f).toLong()
        val diagnostics = ArcadeTrackerDiagnostics(
            mode = stats.mode,
            processedHz = rate.hz,
            processingP50Ms = stats.processingP50Ms,
            processingP90Ms = stats.processingP90Ms,
            inferenceP50Ms = stats.inferenceP50Ms,
            frameAgeP50Ms = stats.frameAgeP50Ms,
            framesSuperseded = stats.framesSuperseded,
            trackingLosses = stats.trackingLosses,
            reacquisitions = stats.reacquisitions,
            processCpuPercent = cpuPercent,
            lastError = stats.lastError,
            searchUpdates = stats.searchUpdates,
            trackUpdates = stats.trackUpdates,
            searchP50Ms = stats.searchP50Ms,
            trackP50Ms = stats.trackP50Ms,
            trackP90Ms = stats.trackP90Ms,
            searchInferenceP50Ms = stats.searchInferenceP50Ms,
            trackInferenceP50Ms = stats.trackInferenceP50Ms,
            lossPresence = stats.lossPresence,
            lossRegion = stats.lossRegion,
            lossWristJump = stats.lossWristJump,
            lossHandedness = stats.lossHandedness,
            lossBackend = stats.lossBackend,
            backendErrors = stats.backendErrors,
            failed = s.failure != null,
        )
        return ArcadeCameraInfo(p.width, p.height, p.frontFacing, stats.processedFrames, micros, diagnostics)
    }

    private fun sampleCpu(now: Long) {
        val cpu = cpuClockMs()
        if (cpuStartMs < 0L || cpu < cpuStartMs) {
            cpuStartMs = cpu
            cpuStartNanos = now
            return
        }
        val wallMs = (now - cpuStartNanos) / 1_000_000L
        if (wallMs < CPU_WINDOW_MS) return
        cpuPercent = 100f * (cpu - cpuStartMs) / wallMs
        cpuStartMs = cpu
        cpuStartNanos = now
    }

    public fun start() {
        wanted = true
        if (source != null) return
        when {
            denied -> state = CameraState.PermissionDenied
            permission.isGranted() -> open()
            requestPending -> state = CameraState.Requesting
            permission.canRequest() -> {
                requestPending = true
                state = CameraState.Requesting
                permission.request()
            }
            else -> {
                denied = true
                state = CameraState.PermissionDenied
            }
        }
    }

    public fun onPermissionResult(granted: Boolean) {
        requestPending = false
        if (!granted) {
            denied = true
            state = CameraState.PermissionDenied
            return
        }
        denied = false
        if (wanted && source == null) open() else if (!wanted) state = CameraState.Off
    }

    public fun stop(reason: ArcadeStopReason) {
        wanted = false
        val current = source
        val consumer = sink
        source = null
        sink = null
        previewSize = null
        current?.stop()
        consumer?.close()
        input.clearCamera()
        input.resetTiming()
        fingers.clear()
        preview.clear()
        if (reason == ArcadeStopReason.ExitArcade) denied = false
        failure = null
        state = when {
            denied -> CameraState.PermissionDenied
            requestPending -> CameraState.Requesting
            else -> CameraState.Off
        }
    }

    private fun open() {
        failure = null
        rate.reset()
        cpuStartMs = -1L
        cpuPercent = Float.NaN
        val newSink = createConsumer(settings)
        val newSource = sourceFactory(newSink)
        sink = newSink
        source = newSource
        state = CameraState.Starting
        newSource.start(object : FrameSourceListener {
            override fun onCameraReady(width: Int, height: Int, frontFacing: Boolean) {
                if (source !== newSource) return
                previewSize = Preview(width, height, frontFacing)
                state = CameraState.Ready
            }

            override fun onCameraFailed(reason: String) {
                if (source !== newSource) return
                failure = reason
                previewSize = null
                state = CameraState.Unavailable
            }
        })
    }

    private fun createConsumer(active: ArcadeTrackerSettings): FrameConsumer {
        if (active.mode == ArcadeTrackerMode.Classical) {
            input.resetTiming()
            return TrackingFrameSink(ClassicalHandTracker(trackerConfig), input, input.cameraGeneration(), processEvery, preview = preview)
        }
        val periodNanos = (1_000_000_000.0 / active.landmarkHz).toLong()
        val factory = landmarkBackendFactory
        val backend = { factory?.invoke(active) ?: throw IllegalStateException("not available in this build") }
        if (active.mode == ArcadeTrackerMode.Fingers) {
            fingers.clear()
            fingers.configure(periodNanos)
            val fingerGeneration = fingers.generation()
            return LandmarkFrameSink(
                backendFactory = backend,
                input = input,
                generation = input.cameraGeneration(),
                settings = active,
                config = LandmarkConfig(idleSearchHz = active.landmarkHz),
                preview = preview,
                gate = nativeGate,
                mode = ArcadeTrackerMode.Fingers,
                trackerFactory = { models, events -> FingerTracker(models, { fingers.publish(it, fingerGeneration) }, FingerConfig(), events) },
                previewCols = FINGER_PREVIEW_COLS,
                previewRows = FINGER_PREVIEW_ROWS,
            )
        }
        input.configureTiming(
            holdNanos = maxOf(HandPositionInput.DEFAULT_HOLD_NANOS, periodNanos * 5 / 2),
            freshNanos = periodNanos * 3 / 2,
        )
        if (active.mode == ArcadeTrackerMode.Face) {
            return LandmarkFrameSink(
                backendFactory = backend,
                input = input,
                generation = input.cameraGeneration(),
                settings = active,
                config = LandmarkConfig(idleSearchHz = active.landmarkHz),
                preview = preview,
                controlRegion = FACE_CONTROL_REGION,
                gate = nativeGate,
                mode = ArcadeTrackerMode.Face,
                trackerFactory = { models, events -> FaceTracker(models, FaceConfig(), events) },
            )
        }
        return LandmarkFrameSink(
            backendFactory = backend,
            input = input,
            generation = input.cameraGeneration(),
            settings = active,
            preview = preview,
            gate = nativeGate,
        )
    }

    public companion object {
        private const val CPU_WINDOW_MS = 1_000L
        private const val FINGER_PREVIEW_COLS = 160
        private const val FINGER_PREVIEW_ROWS = 120
        internal val FACE_CONTROL_REGION: CameraRegion = CameraRegion(0.3f, 0f, 0.7f, 1f)

        public fun forActivity(
            activity: Activity,
            input: HandPositionInput,
            permissionRequestCode: Int,
            settings: ArcadeTrackerSettings = ArcadeTrackerSettings.DEFAULT,
            detectionRegion: CameraRegion = CameraRegion.DEFAULT_DETECTION,
        ): ArcadeCameraSession {
            val appContext = activity.applicationContext
            return ArcadeCameraSession(
                ActivityCameraPermission(activity, permissionRequestCode),
                input,
                TrackerConfig(region = detectionRegion),
                initialSettings = settings,
                landmarkBackendFactory = { s -> NativeHandModels.open(appContext, s.landmarkThreads, face = s.mode == ArcadeTrackerMode.Face) },
            ) { sink -> SerialCameraFrameSource(ArcadeCameraThread, Camera1Driver(sink)) }
        }
    }
}

internal data class PreviewSize(val width: Int, val height: Int)

internal object CameraPreviewPolicy {
    const val TARGET_WIDTH: Int = 320

    /**
     * Smallest preview at least [targetWidth] wide (closest to 4:3 among equal widths); if none is
     * that wide, the widest available.
     */
    fun choose(sizes: List<PreviewSize>, targetWidth: Int = TARGET_WIDTH): PreviewSize? {
        val usable = sizes.filter { it.width > 0 && it.height > 0 }
        if (usable.isEmpty()) return null
        val wideEnough = usable.filter { it.width >= targetWidth }
        if (wideEnough.isEmpty()) return usable.maxByOrNull { it.width * it.height }
        return wideEnough.sortedWith(
            compareBy<PreviewSize> { it.width }.thenBy { abs(it.width.toFloat() / it.height - 4f / 3f) },
        ).first()
    }

    /** NV21 is 12 bits per pixel. */
    fun nv21BufferSize(width: Int, height: Int): Int = width * height * 3 / 2
}

internal sealed class CameraOpenResult {
    data class Opened(val width: Int, val height: Int, val frontFacing: Boolean) : CameraOpenResult()

    data class Failed(val reason: String) : CameraOpenResult()
}

internal interface CameraDriver {
    fun open(onError: (String) -> Unit): CameraOpenResult

    fun release()
}

internal interface CameraWorker {
    fun post(task: () -> Unit)
}

/**
 * Runs every camera open and release on one serial [CameraWorker], so a new source can only open
 * the camera after every earlier release has completed. [stop] never blocks the caller.
 */
internal class SerialCameraFrameSource(
    private val worker: CameraWorker,
    private val driver: CameraDriver,
) : FrameSource {
    @Volatile
    private var stopped = false
    private var started = false

    @Volatile
    var releaseComplete: Boolean = false
        private set

    override fun start(listener: FrameSourceListener) {
        if (started || stopped) return
        started = true
        worker.post { openOnWorker(listener) }
    }

    override fun stop() {
        if (stopped) return
        stopped = true
        if (!started) {
            releaseComplete = true
            return
        }
        worker.post {
            driver.release()
            releaseComplete = true
        }
    }

    private fun openOnWorker(listener: FrameSourceListener) {
        if (stopped) return
        val result = driver.open { reason ->
            driver.release()
            if (!stopped) listener.onCameraFailed(reason)
        }
        when (result) {
            is CameraOpenResult.Opened ->
                if (stopped) driver.release() else listener.onCameraReady(result.width, result.height, result.frontFacing)
            is CameraOpenResult.Failed -> {
                driver.release()
                if (!stopped) listener.onCameraFailed(result.reason)
            }
        }
    }
}
