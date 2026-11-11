// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

public enum class EquipmentCommand(public val id: Int) {
    READ_WRITE_DATA(2),
    DEVICE_INFO(129),
    SYSTEM_INFO(130),
    VERSION_INFO(132),
    VERIFY_SECURITY(144);

    public companion object {
        public fun fromId(id: Int): EquipmentCommand? = entries.firstOrNull { it.id == id }
    }
}
