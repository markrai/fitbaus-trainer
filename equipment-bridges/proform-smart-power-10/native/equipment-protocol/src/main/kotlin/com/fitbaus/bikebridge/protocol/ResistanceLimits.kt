// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

/** Application window for ProForm Smart Power 10 resistance (HTTP and writes). */
public object ResistanceLimits {
    public const val MIN_LEVEL: Int = 1
    public const val MAX_LEVEL: Int = 15

    public fun validate(level: Int): String? {
        if (level < MIN_LEVEL || level > MAX_LEVEL) {
            return "value must be an integer from $MIN_LEVEL to $MAX_LEVEL"
        }
        return null
    }
}
