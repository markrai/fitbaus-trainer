// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

public enum class BikeField(
    public val id: Int,
    public val converter: String,
    public val encoding: FieldEncoding,
) {
    RESISTANCE(2, "ResistanceConverter", FieldEncoding.Unresolved),
    WATTS(3, "ShortConverter", FieldEncoding.UnsignedLittleEndian(2)),
    RPM(5, "ShortConverter", FieldEncoding.UnsignedLittleEndian(2)),
    WORKOUT_MODE(12, "ModeConverter", FieldEncoding.WorkoutModeCode),
    ACTUAL_RESISTANCE(18, "ResistanceConverter", FieldEncoding.Unresolved),
    MAX_RESISTANCE_LEVEL(42, "ByteConverter", FieldEncoding.UnsignedLittleEndian(1)),
    IDLE_MODE_LOCKOUT(95, "BoolConverter", FieldEncoding.Flag);

    public val width: Int? get() = encoding.width

    public val isResolved: Boolean get() = encoding.width != null
}

public sealed class FieldEncoding(public val width: Int?) {
    public class UnsignedLittleEndian internal constructor(width: Int) : FieldEncoding(width) {
        init {
            require(width in 1..4) { "unsupported unsigned width $width" }
        }

        override fun toString(): String = "UnsignedLittleEndian($width)"
    }

    public object Flag : FieldEncoding(1) {
        override fun toString(): String = "Flag"
    }

    public object WorkoutModeCode : FieldEncoding(1) {
        override fun toString(): String = "WorkoutModeCode"
    }

    public object Unresolved : FieldEncoding(null) {
        override fun toString(): String = "Unresolved"
    }
}

public sealed class FieldValue {
    public class Number internal constructor(public val value: Long) : FieldValue() {
        override fun equals(other: Any?): Boolean = other is Number && other.value == value
        override fun hashCode(): Int = value.hashCode()
        override fun toString(): String = "Number($value)"
    }

    public class Flag internal constructor(public val value: Boolean) : FieldValue() {
        override fun equals(other: Any?): Boolean = other is Flag && other.value == value
        override fun hashCode(): Int = value.hashCode()
        override fun toString(): String = "Flag($value)"
    }

    public class Mode internal constructor(public val code: Int) : FieldValue() {
        public val mode: WorkoutMode? get() = WorkoutMode.fromCode(code)
        override fun equals(other: Any?): Boolean = other is Mode && other.code == code
        override fun hashCode(): Int = code
        override fun toString(): String = "Mode($code${mode?.let { " $it" } ?: ""})"
    }

    public object Sentinel : FieldValue() {
        override fun toString(): String = "Sentinel"
    }

    public class InvalidEncoding internal constructor(private val raw: ByteArray) : FieldValue() {
        public fun bytes(): ByteArray = raw.copyOf()
        override fun equals(other: Any?): Boolean = other is InvalidEncoding && other.raw.contentEquals(raw)
        override fun hashCode(): Int = raw.contentHashCode()
        override fun toString(): String = "InvalidEncoding(${Hex.format(raw)})"
    }

    public class Undecoded internal constructor(private val raw: ByteArray) : FieldValue() {
        public val width: Int get() = raw.size
        public fun bytes(): ByteArray = raw.copyOf()
        override fun equals(other: Any?): Boolean = other is Undecoded && other.raw.contentEquals(raw)
        override fun hashCode(): Int = raw.contentHashCode()
        override fun toString(): String = "Undecoded(${Hex.format(raw)})"
    }
}

public object Hex {
    public fun format(bytes: ByteArray): String =
        bytes.joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }
}
