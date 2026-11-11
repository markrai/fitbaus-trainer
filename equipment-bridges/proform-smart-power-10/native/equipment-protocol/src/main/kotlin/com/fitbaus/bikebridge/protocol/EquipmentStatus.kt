// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

public enum class EquipmentStatus(public val code: Int?) {
    DEVICE_NOT_SUPPORTED(0),
    COMMAND_NOT_SUPPORTED(1),
    DONE(2),
    IN_PROGRESS(3),
    FAILED(4),
    TIME_LEFT(5),
    UNKNOWN_FAILURE(7),
    SECURITY_BLOCK(8),
    COMMUNICATION_FAILED(9),
    UNRECOGNIZED(null);

    public companion object {
        public fun fromCode(code: Int): EquipmentStatus =
            entries.firstOrNull { it.code != null && it.code == code } ?: UNRECOGNIZED
    }
}
