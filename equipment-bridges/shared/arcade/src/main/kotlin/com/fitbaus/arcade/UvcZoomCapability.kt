// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

/**
 * Absolute zoom range reported by a live UVC device.
 *
 * For UVC CT_ZOOM_ABSOLUTE, lower values are typically the wider field of view.
 * [supported] is false when the device does not expose a usable adjustable range.
 */
public data class UvcZoomCapability(
    public val supported: Boolean,
    public val min: Int,
    public val max: Int,
    public val step: Int,
    public val default: Int,
    public val current: Int,
) {
    public fun clamp(value: Int): Int {
        if (!supported) return current
        if (value <= min) return min
        if (value >= max) return max
        if (step <= 1) return value
        val offset = value - min
        val snapped = min + (offset / step) * step
        return snapped.coerceIn(min, max)
    }

    public fun widest(): Int = min

    public companion object {
        public val UNSUPPORTED: UvcZoomCapability =
            UvcZoomCapability(supported = false, min = 0, max = 0, step = 0, default = 0, current = 0)

        /**
         * Builds a capability from native query fields.
         * Order: supportedFlag, min, max, step, default, current.
         * Invalid or contradictory ranges become [UNSUPPORTED].
         */
        public fun fromQuery(values: IntArray?): UvcZoomCapability {
            if (values == null || values.size < 6) return UNSUPPORTED
            if (values[0] == 0) return UNSUPPORTED
            val min = values[1]
            val max = values[2]
            val step = values[3]
            val default = values[4]
            val current = values[5]
            if (min < 0 || max < 0 || step <= 0 || min > max) return UNSUPPORTED
            if (min == max) return UNSUPPORTED
            if (default < min || default > max) return UNSUPPORTED
            if (current < min || current > max) return UNSUPPORTED
            val span = max - min
            if (span % step != 0) return UNSUPPORTED
            if ((default - min) % step != 0) return UNSUPPORTED
            if ((current - min) % step != 0) return UNSUPPORTED
            return UvcZoomCapability(
                supported = true,
                min = min,
                max = max,
                step = step,
                default = default,
                current = current,
            )
        }
    }
}

/** Public zoom control surface for host modules that must not touch [UvcNative] directly. */
public object UvcZoomControls {
    public fun capability(handle: Long): UvcZoomCapability =
        UvcNative.zoomCapability(handle)

    public fun setAbsolute(handle: Long, value: Int): Boolean =
        handle != 0L && UvcNative.setZoomAbs(handle, value)
}

/** Saved absolute-zoom preference for a camera identity. */
public sealed class UvcZoomPreference {
    public data object Widest : UvcZoomPreference()
    public data object CameraDefault : UvcZoomPreference()
    public data class Absolute(val value: Int) : UvcZoomPreference()

    public fun resolve(capability: UvcZoomCapability): Int? {
        if (!capability.supported) return null
        return when (this) {
            Widest -> capability.widest()
            CameraDefault -> capability.default
            is Absolute -> capability.clamp(value)
        }
    }
}
