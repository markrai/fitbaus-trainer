// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal class NativeSessionGate {
    private val permits = Semaphore(1)

    fun acquire(sliceNanos: Long, keepWaiting: () -> Boolean): Boolean {
        while (keepWaiting()) {
            if (permits.tryAcquire(sliceNanos, TimeUnit.NANOSECONDS)) return true
        }
        return false
    }

    fun release() {
        permits.release()
    }

    val available: Int
        get() = permits.availablePermits()

    companion object {
        val SHARED: NativeSessionGate = NativeSessionGate()
    }
}

internal class LandmarkFrameSink(
    private val backendFactory: () -> HandModelBackend,
    private val input: HandPositionInput,
    private val generation: Int,
    private val settings: ArcadeTrackerSettings,
    private val config: LandmarkConfig = LandmarkConfig(),
    private val preview: ArcadePreview? = null,
    private val controlRegion: CameraRegion = CameraRegion.FULL,
    private val clock: () -> Long = { System.nanoTime() },
    startWorker: Boolean = true,
    private val gate: NativeSessionGate = NativeSessionGate.SHARED,
    private val log: (String) -> Unit = { android.util.Log.i(LOG_TAG, it) },
    private val mode: ArcadeTrackerMode = ArcadeTrackerMode.Landmark,
    private val trackerFactory: (HandModelBackend, (String) -> Unit) -> NativeFrameTracker = { models, events ->
        LandmarkHandTracker(models, config, events)
    },
    private val previewCols: Int = PREVIEW_COLS,
    private val previewRows: Int = PREVIEW_ROWS,
) : FrameConsumer {
    private val lock = ReentrantLock()
    private val frameReady = lock.newCondition()
    private val trackPeriodNanos = (1_000_000_000.0 / settings.landmarkHz).toLong()
    private val idleSearchPeriodNanos = maxOf(trackPeriodNanos, (1_000_000_000.0 / config.idleSearchHz).toLong())
    private val previewGeneration = preview?.currentGeneration() ?: 0
    private val processing = DurationWindow()
    private val inference = DurationWindow()
    private val searchProcessing = DurationWindow()
    private val trackProcessing = DurationWindow()
    private val searchInference = DurationWindow()
    private val trackInference = DurationWindow()
    private val frameAge = DurationWindow()

    private var pending = ByteArray(0)
    private var working = ByteArray(0)
    private var pendingWidth = 0
    private var pendingHeight = 0
    private var pendingAtNanos = 0L
    private var pendingFresh = false
    private var closed = false
    private var nextDueNanos = Long.MIN_VALUE
    private var firstStepNanos = Long.MIN_VALUE
    private var lastLossNanos = Long.MIN_VALUE
    private var seenLosses = 0
    private var backend: HandModelBackend? = null
    private var tracker: NativeFrameTracker? = null
    private var gateHeld = false
    private val previewPixels = IntArray(previewCols * previewRows)

    @Volatile
    override var mirror: Boolean = true

    @Volatile
    var processedFrames: Long = 0L
        private set

    @Volatile
    var framesSuperseded: Long = 0L
        private set

    @Volatile
    var lastError: String? = null
        private set

    @Volatile
    override var failure: String? = null
        private set

    @Volatile
    var searchUpdates: Long = 0L
        private set

    @Volatile
    var trackUpdates: Long = 0L
        private set

    @Volatile
    private var snapshot = IntArray(LossReason.values().size + 3)

    private val worker: Thread? = if (startWorker) {
        Thread({ runWorker() }, "fitbaus-arcade-landmark").also { it.start() }
    } else {
        null
    }

    override fun onFrame(nv21: ByteArray, width: Int, height: Int): Boolean {
        val size = width * height * 3 / 2
        if (width <= 1 || height <= 1 || nv21.size < size) return false
        lock.withLock {
            if (closed || failure != null) return false
            if (pending.size != size) pending = ByteArray(size)
            System.arraycopy(nv21, 0, pending, 0, size)
            if (pendingFresh) framesSuperseded += 1
            pendingWidth = width
            pendingHeight = height
            pendingAtNanos = clock()
            pendingFresh = true
            frameReady.signalAll()
        }
        return true
    }

    fun step(nowNanos: Long): Boolean {
        val width: Int
        val height: Int
        val ageNanos: Long
        lock.withLock {
            if (closed || failure != null || !pendingFresh || nowNanos < nextDueNanos) return false
            val swap = working
            working = pending
            pending = swap
            width = pendingWidth
            height = pendingHeight
            ageNanos = nowNanos - pendingAtNanos
            pendingFresh = false
        }
        val activeTracker = tracker ?: createTracker() ?: return false
        val start = clock()
        if (firstStepNanos == Long.MIN_VALUE) firstStepNanos = start
        val point = activeTracker.process(working, width, height, start)
        val end = clock()
        val elapsedMs = (end - start) / 1_000_000f
        val searched = activeTracker.lastUpdateSearched
        processing.record(elapsedMs)
        inference.record(activeTracker.lastInferenceMs)
        if (searched) {
            searchUpdates += 1
            searchProcessing.record(elapsedMs)
            searchInference.record(activeTracker.lastInferenceMs)
        } else {
            trackUpdates += 1
            trackProcessing.record(elapsedMs)
            trackInference.record(activeTracker.lastInferenceMs)
        }
        frameAge.record(ageNanos / 1_000_000f)
        processedFrames += 1
        if (activeTracker.lossCount > seenLosses) {
            seenLosses = activeTracker.lossCount
            lastLossNanos = start
        }
        snapshot = intArrayOf(
            activeTracker.losses(LossReason.Presence),
            activeTracker.losses(LossReason.Region),
            activeTracker.losses(LossReason.WristJump),
            activeTracker.losses(LossReason.Handedness),
            activeTracker.losses(LossReason.BackendError),
            activeTracker.lossCount,
            activeTracker.reacquisitions,
            activeTracker.backendErrors,
        )
        if (activeTracker.consecutiveBackendErrors >= config.maxConsecutiveBackendErrors) {
            fail("native inference failed ${activeTracker.consecutiveBackendErrors} times in a row (status ${activeTracker.lastBackendStatus})")
            return true
        }
        if (point != null) {
            val mapped = HandMapping.fromCamera(point.x, point.y, mirror, controlRegion)
            input.publishCamera(mapped.x, mapped.y, point.confidence, end, generation)
        }
        publishPreview(width, height, point)
        val period = if (activeTracker.isTracking) trackPeriodNanos else searchPeriod(start)
        lock.withLock { nextDueNanos = start + period }
        return true
    }

    private fun searchPeriod(now: Long): Long {
        val initial = now - firstStepNanos < config.initialFastSearchNanos
        val afterLoss = lastLossNanos != Long.MIN_VALUE && now - lastLossNanos < config.fastSearchAfterLossNanos
        return if (initial || afterLoss) trackPeriodNanos else idleSearchPeriodNanos
    }

    override fun close() {
        val ownsBackend: Boolean
        lock.withLock {
            if (closed) return
            closed = true
            frameReady.signalAll()
            ownsBackend = worker == null
        }
        if (ownsBackend) releaseBackend()
    }

    override fun stats(): TrackerStats {
        val s = snapshot
        return TrackerStats(
            mode = mode,
            processedFrames = processedFrames,
            processingP50Ms = processing.percentile(0.5f),
            processingP90Ms = processing.percentile(0.9f),
            inferenceP50Ms = inference.percentile(0.5f),
            frameAgeP50Ms = frameAge.percentile(0.5f),
            framesSuperseded = framesSuperseded,
            trackingLosses = s[5],
            reacquisitions = s[6],
            lastError = lastError,
            searchUpdates = searchUpdates,
            trackUpdates = trackUpdates,
            searchP50Ms = searchProcessing.percentile(0.5f),
            trackP50Ms = trackProcessing.percentile(0.5f),
            trackP90Ms = trackProcessing.percentile(0.9f),
            searchInferenceP50Ms = searchInference.percentile(0.5f),
            trackInferenceP50Ms = trackInference.percentile(0.5f),
            lossPresence = s[0],
            lossRegion = s[1],
            lossWristJump = s[2],
            lossHandedness = s[3],
            lossBackend = s[4],
            backendErrors = s[7],
        )
    }

    private fun createTracker(): NativeFrameTracker? {
        if (!gateHeld) {
            if (!gate.acquire(GATE_SLICE_NANOS) { !isClosed() }) return null
            gateHeld = true
        }
        return try {
            val created = backendFactory()
            backend = created
            trackerFactory(created, log).also { tracker = it }
        } catch (e: Throwable) {
            fail("landmark tracker unavailable: " + (e.message ?: e.javaClass.simpleName))
            null
        }
    }

    private fun fail(reason: String) {
        lastError = reason
        failure = reason
        log(reason)
        releaseBackend()
    }

    private fun isClosed(): Boolean = lock.withLock { closed }

    private fun publishPreview(width: Int, height: Int, point: LandmarkPoint?) {
        val target = preview ?: return
        val models = backend ?: return
        models.renderPreview(working, width, height, previewCols, previewRows, mirror, previewPixels)
        val flip = mirror
        val px = if (point == null) Float.NaN else if (flip) 1f - point.x else point.x
        val py = point?.y ?: Float.NaN
        val r = controlRegion
        target.publish(
            previewPixels,
            previewCols,
            previewRows,
            px,
            py,
            if (flip) 1f - r.right else r.left,
            r.top,
            if (flip) 1f - r.left else r.right,
            r.bottom,
            previewGeneration,
        )
    }

    private fun runWorker() {
        try {
            while (true) {
                lock.withLock {
                    while (!closed) {
                        val now = clock()
                        if (pendingFresh && now >= nextDueNanos && failure == null) break
                        val waitNanos = if (!pendingFresh || failure != null) IDLE_WAIT_NANOS else (nextDueNanos - now).coerceAtLeast(1_000_000L)
                        frameReady.awaitNanos(waitNanos.coerceAtMost(TimeUnit.MILLISECONDS.toNanos(250)))
                    }
                    if (closed) return
                }
                step(clock())
            }
        } finally {
            releaseBackend()
        }
    }

    private fun releaseBackend() {
        val models = backend
        backend = null
        tracker = null
        try {
            models?.close()
        } catch (_: RuntimeException) {
        }
        if (gateHeld) {
            gateHeld = false
            gate.release()
        }
    }

    companion object {
        const val LOG_TAG: String = "FitbausArcade"
        private const val PREVIEW_COLS = 80
        private const val PREVIEW_ROWS = 60
        private const val IDLE_WAIT_NANOS = 100_000_000L
        private const val GATE_SLICE_NANOS = 100_000_000L
    }
}
