// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host.policy

import com.fitbaus.bikebridge.protocol.BikeField

internal object ApprovedReadFields {
    val ALL: Set<Int> = setOf(
        BikeField.RESISTANCE.id,
        BikeField.WATTS.id,
        BikeField.RPM.id,
        BikeField.WORKOUT_MODE.id,
        BikeField.ACTUAL_RESISTANCE.id,
        BikeField.MAX_RESISTANCE_LEVEL.id,
        BikeField.IDLE_MODE_LOCKOUT.id,
    )

    val TELEMETRY_NON_SENSITIVE: Set<Int> = setOf(
        BikeField.WATTS.id,
        BikeField.RPM.id,
        BikeField.RESISTANCE.id,
        BikeField.ACTUAL_RESISTANCE.id,
        BikeField.WORKOUT_MODE.id,
        BikeField.MAX_RESISTANCE_LEVEL.id,
        BikeField.IDLE_MODE_LOCKOUT.id,
    )
}
