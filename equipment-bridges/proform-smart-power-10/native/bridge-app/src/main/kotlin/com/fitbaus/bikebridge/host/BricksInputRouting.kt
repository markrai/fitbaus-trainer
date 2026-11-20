// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

import com.fitbaus.arcade.ArcadeStatus
import com.fitbaus.arcade.BricksInputSource
import com.fitbaus.arcade.HandPosition
import com.fitbaus.arcade.HandSource

internal data class BricksInputFrame(val position: HandPosition, val status: ArcadeStatus)

internal object BricksInputRouting {
    fun resolve(
        source: BricksInputSource,
        nowNanos: Long,
        touch: HandPosition?,
        controller: HandPosition?,
        camera: () -> HandPosition,
        cameraStatus: () -> ArcadeStatus,
    ): BricksInputFrame = when {
        source == BricksInputSource.Webcam ->
            BricksInputFrame(touch ?: camera(), cameraStatus())
        touch != null ->
            BricksInputFrame(touch, ArcadeStatus.ControllerReady)
        controller != null ->
            BricksInputFrame(controller, ArcadeStatus.ControllerReady)
        else ->
            BricksInputFrame(
                HandPosition(0.5f, 0.5f, 0f, nowNanos, HandSource.Lost),
                ArcadeStatus.ControllerUnavailable,
            )
    }
}
