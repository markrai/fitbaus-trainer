// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class HandInputTest {
    private val ms = 1_000_000L

    @Test
    fun clampAndNormalize() {
        assertEquals(0f, HandMapping.clamp01(-0.2f))
        assertEquals(1f, HandMapping.clamp01(1.7f))
        assertEquals(0.5f, HandMapping.clamp01(Float.NaN))
        assertEquals(0.25f, HandMapping.normalize(100f, 400f))
        assertEquals(1f, HandMapping.normalize(500f, 400f))
        assertEquals(0.5f, HandMapping.normalize(10f, 0f))
        val touch = HandMapping.fromTouch(-5f, 300f, 800f, 200f)
        assertEquals(0f, touch.x)
        assertEquals(1f, touch.y)
    }

    @Test
    fun frontCameraIsMirrored() {
        val mirrored = HandMapping.fromCamera(0.2f, 0.4f, mirror = true)
        assertEquals(0.8f, mirrored.x, 1e-6f)
        assertEquals(0.4f, mirrored.y, 1e-6f)
        val raw = HandMapping.fromCamera(0.2f, 0.4f, mirror = false)
        assertEquals(0.2f, raw.x, 1e-6f)
        assertEquals(1f, HandMapping.fromCamera(-1f, 2f, mirror = true).x)
        assertEquals(1f, HandMapping.fromCamera(-1f, 2f, mirror = true).y)
    }

    @Test
    fun detectionRegionIsAppliedInCameraSpaceBeforeMirroring() {
        val leftHalf = CameraRegion(0f, 0.5f, 0.5f, 1f)
        val raw = HandMapping.fromCamera(0.125f, 0.75f, mirror = false, region = leftHalf)
        assertEquals(0.25f, raw.x, 1e-6f)
        assertEquals(0.5f, raw.y, 1e-6f)
        val mirrored = HandMapping.fromCamera(0.125f, 0.75f, mirror = true, region = leftHalf)
        assertEquals(0.75f, mirrored.x, 1e-6f)
        assertEquals(1f, HandMapping.fromCamera(0.9f, 0.75f, mirror = false, region = leftHalf).x)
        assertEquals(0f, HandMapping.fromCamera(0.9f, 0.75f, mirror = true, region = leftHalf).x)
        assertEquals(0f, HandMapping.fromCamera(0.2f, 0.1f, mirror = false, region = leftHalf).y)
    }

    @Test
    fun aspectRegionCropsAndMapsToUnitSquare() {
        // 4:3 camera onto a 16:9 playground: crop top/bottom.
        val wide = CameraRegion.forAspect(320, 240, 1600, 900)
        assertEquals(0f, wide.left)
        assertEquals(1f, wide.right)
        assertEquals(0.125f, wide.top, 1e-4f)
        assertEquals(0.875f, wide.bottom, 1e-4f)
        assertEquals(0f, HandMapping.fromCamera(0.5f, 0.1f, false, wide).y)
        assertEquals(0.5f, HandMapping.fromCamera(0.5f, 0.5f, false, wide).y, 1e-6f)
        assertEquals(1f, HandMapping.fromCamera(0.5f, 0.9f, false, wide).y)
        // 4:3 camera onto a 1:1 playground: crop left/right.
        val square = CameraRegion.forAspect(320, 240, 500, 500)
        assertEquals(0.125f, square.left, 1e-4f)
        assertEquals(0.875f, square.right, 1e-4f)
        assertEquals(0f, square.top)
        assertEquals(CameraRegion.FULL, CameraRegion.forAspect(0, 240, 500, 500))
    }

    @Test
    fun touchOverridesCameraWhileFingerDown() {
        val input = HandPositionInput()
        val gen = input.cameraGeneration()
        input.publishCamera(0.2f, 0.3f, 0.9f, 1_000 * ms, gen)
        assertEquals(HandSource.Camera, input.latest(1_010 * ms).source)
        input.onTouch(0.7f, 0.6f)
        val touched = input.latest(1_020 * ms)
        assertEquals(HandSource.Touch, touched.source)
        assertEquals(0.7f, touched.x)
        assertEquals(1f, touched.confidence)
        input.publishCamera(0.25f, 0.3f, 0.9f, 1_030 * ms, gen)
        assertEquals(HandSource.Touch, input.latest(1_040 * ms).source)
        input.onTouchUp()
        val back = input.latest(1_050 * ms)
        assertEquals(HandSource.Camera, back.source)
        assertEquals(0.25f, back.x)
    }

    @Test
    fun lostTrackingHoldsThenReportsLostAtLastKnownPosition() {
        val input = HandPositionInput(holdNanos = 500 * ms, freshNanos = 150 * ms)
        val first = input.latest(0L)
        assertEquals(HandSource.Lost, first.source)
        assertEquals(0.5f, first.x)
        assertFalse(input.hasEverTracked())

        input.publishCamera(0.3f, 0.4f, 1f, 1_000 * ms, input.cameraGeneration())
        val fresh = input.latest(1_100 * ms)
        assertEquals(HandSource.Camera, fresh.source)
        assertEquals(1f, fresh.confidence)
        assertTrue(input.hasEverTracked())

        val held = input.latest(1_400 * ms)
        assertEquals(HandSource.Camera, held.source)
        assertTrue(held.confidence < 1f && held.confidence > 0f, "held confidence decays: ${held.confidence}")

        val lost = input.latest(1_600 * ms)
        assertEquals(HandSource.Lost, lost.source)
        assertEquals(0.3f, lost.x)
        assertEquals(0.4f, lost.y)
        assertEquals(0f, lost.confidence)
        assertFalse(input.cameraTracking(1_600 * ms))
        assertTrue(input.hasEverTracked())
    }

    @Test
    fun touchReleaseKeepsLastTouchPositionWhenNoCamera() {
        val input = HandPositionInput()
        input.onTouch(0.9f, 0.1f)
        input.latest(1L)
        input.onTouchUp()
        val after = input.latest(2L)
        assertEquals(HandSource.Lost, after.source)
        assertEquals(0.9f, after.x)
    }

    @Test
    fun clearCameraDropsLateSamplesFromStoppedSession() {
        val input = HandPositionInput()
        val oldGen = input.cameraGeneration()
        input.publishCamera(0.2f, 0.2f, 1f, 1_000 * ms, oldGen)
        assertTrue(input.cameraTracking(1_001 * ms))
        input.clearCamera()
        assertFalse(input.cameraTracking(1_002 * ms))
        assertFalse(input.hasEverTracked())
        input.publishCamera(0.8f, 0.8f, 1f, 1_003 * ms, oldGen)
        assertEquals(HandSource.Lost, input.latest(1_004 * ms).source)
        input.publishCamera(0.6f, 0.6f, 1f, 1_005 * ms, input.cameraGeneration())
        assertEquals(0.6f, input.latest(1_006 * ms).x)
    }

    @Test
    fun statusResolution() {
        val r = ArcadeStatusResolver
        assertEquals(ArcadeStatus.PermissionDenied, r.resolve(CameraState.PermissionDenied, cameraTracking = false, everTracked = false))
        assertEquals(ArcadeStatus.Unavailable, r.resolve(CameraState.Unavailable, cameraTracking = false, everTracked = true))
        assertEquals(ArcadeStatus.TouchOnly, r.resolve(CameraState.Off, cameraTracking = false, everTracked = false))
        assertEquals(ArcadeStatus.TouchOnly, r.resolve(CameraState.Requesting, cameraTracking = false, everTracked = false))
        assertEquals(ArcadeStatus.TouchOnly, r.resolve(CameraState.Starting, cameraTracking = false, everTracked = false))
        assertEquals(ArcadeStatus.CameraReady, r.resolve(CameraState.Ready, cameraTracking = false, everTracked = false))
        assertEquals(ArcadeStatus.Tracking, r.resolve(CameraState.Ready, cameraTracking = true, everTracked = true))
        assertEquals(ArcadeStatus.TrackingLost, r.resolve(CameraState.Ready, cameraTracking = false, everTracked = true))
    }

    @Test
    fun rateMeterReportsHzPerWindow() {
        val meter = RateMeter(windowNanos = 1_000 * ms)
        assertFalse(meter.update(0L, 0L))
        assertFalse(meter.update(10L, 500 * ms))
        assertTrue(meter.update(15L, 1_000 * ms))
        assertEquals(15f, meter.hz, 0.01f)
        assertFalse(meter.update(3L, 1_100 * ms), "counter reset restarts the window")
    }
}
