// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

public enum class CameraState { Off, Requesting, Starting, Ready, PermissionDenied, Unavailable }

public enum class ArcadeStatus(public val label: String) {
    CameraReady("Camera ready - raise a hand"),
    PermissionDenied("Camera permission denied - touch to play"),
    Unavailable("Camera unavailable - touch to play"),
    Tracking("Tracking hand"),
    TrackingLost("Hand lost - raise a hand"),
    TouchOnly("Touch to play"),
}

public object ArcadeStatusResolver {
    public fun resolve(camera: CameraState, cameraTracking: Boolean, everTracked: Boolean): ArcadeStatus = when (camera) {
        CameraState.PermissionDenied -> ArcadeStatus.PermissionDenied
        CameraState.Unavailable -> ArcadeStatus.Unavailable
        CameraState.Off, CameraState.Requesting, CameraState.Starting -> ArcadeStatus.TouchOnly
        CameraState.Ready -> when {
            cameraTracking -> ArcadeStatus.Tracking
            everTracked -> ArcadeStatus.TrackingLost
            else -> ArcadeStatus.CameraReady
        }
    }
}

/** Frames-per-second over a rolling window, fed with a monotonically increasing frame count. */
public class RateMeter(private val windowNanos: Long = 1_000_000_000L) {
    private var windowStart = -1L
    private var windowCount = 0L
    public var hz: Float = 0f
        private set

    public fun reset() {
        windowStart = -1L
        windowCount = 0L
        hz = 0f
    }

    /** Returns true when [hz] was recomputed. */
    public fun update(count: Long, nowNanos: Long): Boolean {
        if (windowStart < 0L || count < windowCount) {
            windowStart = nowNanos
            windowCount = count
            return false
        }
        val elapsed = nowNanos - windowStart
        if (elapsed < windowNanos) return false
        hz = (count - windowCount) * 1_000_000_000f / elapsed
        windowStart = nowNanos
        windowCount = count
        return true
    }
}
