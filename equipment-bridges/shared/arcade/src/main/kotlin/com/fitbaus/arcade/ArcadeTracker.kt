// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import java.util.Locale

public enum class ArcadeTrackerMode { Classical, Landmark, Face, Fingers }

public data class ArcadeTrackerSettings(
    public val mode: ArcadeTrackerMode = ArcadeTrackerMode.Classical,
    public val landmarkHz: Float = 5f,
    public val landmarkThreads: Int = 2,
) {
    init {
        require(landmarkHz >= 0.5f && landmarkHz <= 30f) { "landmarkHz must be in 0.5..30" }
        require(landmarkThreads in 1..4) { "landmarkThreads must be in 1..4" }
    }

    public val label: String
        get() = when (mode) {
            ArcadeTrackerMode.Classical -> "Classical"
            else -> String.format(
                Locale.US,
                "%s %s Hz, %d thread%s",
                when (mode) {
                    ArcadeTrackerMode.Face -> "Face"
                    ArcadeTrackerMode.Fingers -> "Fingers"
                    else -> "Landmark"
                },
                if (landmarkHz % 1f == 0f) landmarkHz.toInt().toString() else landmarkHz.toString(),
                landmarkThreads,
                if (landmarkThreads == 1) "" else "s",
            )
        }

    public val key: String
        get() = when (mode) {
            ArcadeTrackerMode.Classical -> "classical"
            ArcadeTrackerMode.Landmark -> "landmark:$landmarkHz:$landmarkThreads"
            ArcadeTrackerMode.Face -> "face:$landmarkHz:$landmarkThreads"
            ArcadeTrackerMode.Fingers -> "fingers:$landmarkHz:$landmarkThreads"
        }

    public companion object {
        public val CLASSICAL: ArcadeTrackerSettings = ArcadeTrackerSettings()
        public val LANDMARK_DEFAULT: ArcadeTrackerSettings = ArcadeTrackerSettings(ArcadeTrackerMode.Landmark, 5f, 2)
        public val FACE_DEFAULT: ArcadeTrackerSettings = ArcadeTrackerSettings(ArcadeTrackerMode.Face, 10f, 1)
        public val DEFAULT: ArcadeTrackerSettings = FACE_DEFAULT
        public val PRESETS: List<ArcadeTrackerSettings> = listOf(
            FACE_DEFAULT,
            ArcadeTrackerSettings(ArcadeTrackerMode.Face, 15f, 1),
            CLASSICAL,
            LANDMARK_DEFAULT,
            ArcadeTrackerSettings(ArcadeTrackerMode.Landmark, 5f, 1),
            ArcadeTrackerSettings(ArcadeTrackerMode.Landmark, 3f, 1),
            ArcadeTrackerSettings(ArcadeTrackerMode.Landmark, 8f, 2),
            ArcadeTrackerSettings(ArcadeTrackerMode.Landmark, 10f, 2),
        )

        public val FINGERS_DEFAULT: ArcadeTrackerSettings = ArcadeTrackerSettings(ArcadeTrackerMode.Fingers, 2f, 2)
        public val FINGER_PRESETS: List<ArcadeTrackerSettings> = listOf(
            FINGERS_DEFAULT,
            ArcadeTrackerSettings(ArcadeTrackerMode.Fingers, 1.5f, 2),
            ArcadeTrackerSettings(ArcadeTrackerMode.Fingers, 1.5f, 1),
        )

        public fun fromKey(key: String?): ArcadeTrackerSettings = PRESETS.firstOrNull { it.key == key } ?: DEFAULT

        public fun fingersFromKey(key: String?): ArcadeTrackerSettings = FINGER_PRESETS.firstOrNull { it.key == key } ?: FINGERS_DEFAULT

        public val FACE_PRESETS: List<ArcadeTrackerSettings> = listOf(FACE_DEFAULT, ArcadeTrackerSettings(ArcadeTrackerMode.Face, 15f, 1))

        public fun faceFromKey(key: String?): ArcadeTrackerSettings = FACE_PRESETS.firstOrNull { it.key == key } ?: FACE_DEFAULT
    }
}

public data class ArcadeTrackerDiagnostics(
    public val mode: ArcadeTrackerMode,
    public val processedHz: Float,
    public val processingP50Ms: Float,
    public val processingP90Ms: Float,
    public val inferenceP50Ms: Float,
    public val frameAgeP50Ms: Float,
    public val framesSuperseded: Long,
    public val trackingLosses: Int,
    public val reacquisitions: Int,
    public val processCpuPercent: Float,
    public val lastError: String?,
    public val searchUpdates: Long = 0L,
    public val trackUpdates: Long = 0L,
    public val searchP50Ms: Float = Float.NaN,
    public val trackP50Ms: Float = Float.NaN,
    public val trackP90Ms: Float = Float.NaN,
    public val searchInferenceP50Ms: Float = Float.NaN,
    public val trackInferenceP50Ms: Float = Float.NaN,
    public val lossPresence: Int = 0,
    public val lossRegion: Int = 0,
    public val lossWristJump: Int = 0,
    public val lossHandedness: Int = 0,
    public val lossBackend: Int = 0,
    public val backendErrors: Int = 0,
    public val failed: Boolean = false,
)

internal class TrackerStats(
    val mode: ArcadeTrackerMode,
    val processedFrames: Long,
    val processingP50Ms: Float,
    val processingP90Ms: Float,
    val inferenceP50Ms: Float,
    val frameAgeP50Ms: Float,
    val framesSuperseded: Long,
    val trackingLosses: Int,
    val reacquisitions: Int,
    val lastError: String?,
    val searchUpdates: Long = 0L,
    val trackUpdates: Long = 0L,
    val searchP50Ms: Float = Float.NaN,
    val trackP50Ms: Float = Float.NaN,
    val trackP90Ms: Float = Float.NaN,
    val searchInferenceP50Ms: Float = Float.NaN,
    val trackInferenceP50Ms: Float = Float.NaN,
    val lossPresence: Int = 0,
    val lossRegion: Int = 0,
    val lossWristJump: Int = 0,
    val lossHandedness: Int = 0,
    val lossBackend: Int = 0,
    val backendErrors: Int = 0,
)

internal interface FrameConsumer {
    var mirror: Boolean

    val failure: String?

    fun onFrame(nv21: ByteArray, width: Int, height: Int): Boolean

    fun close()

    fun stats(): TrackerStats
}

internal class DurationWindow(capacity: Int = 64) {
    private val values = FloatArray(capacity)
    private var count = 0
    private var next = 0

    @Synchronized
    fun record(ms: Float) {
        values[next] = ms
        next = (next + 1) % values.size
        if (count < values.size) count += 1
    }

    @Synchronized
    fun percentile(fraction: Float): Float {
        if (count == 0) return Float.NaN
        val sorted = values.copyOf(count)
        sorted.sort()
        val index = ((count - 1) * fraction).toInt().coerceIn(0, count - 1)
        return sorted[index]
    }
}
