// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

public enum class WorkoutMode(public val code: Int) {
    UNKNOWN(0),
    IDLE(1),
    RUNNING(2),
    PAUSE(3),
    RESULTS(4),
    DEBUG(5),
    LOG(6),
    MAINTENANCE(7),
    SAFETY_KEY_REMOVED(8),
    DEMO(9),
    WARM_UP(10),
    COOL_DOWN(11),
    SLEEP(12),
    RESUME(13),
    LOCKED(14),
    PAUSE_OVERRIDE(20);

    public companion object {
        public fun fromCode(code: Int): WorkoutMode? = entries.firstOrNull { it.code == code }
    }
}
