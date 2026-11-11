// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

internal class RawFieldWrite(val fieldId: Int, value: ByteArray) {
    private val bytes: ByteArray = value.copyOf()

    init {
        require(fieldId in 0..MAX_FIELD_ID) { "field id $fieldId outside 0..$MAX_FIELD_ID" }
        require(bytes.isNotEmpty()) { "write for field $fieldId has no value bytes" }
    }

    fun value(): ByteArray = bytes.copyOf()

    companion object {
        const val MAX_FIELD_ID: Int = 255
    }
}

internal object ReadWriteDataCodec {
    fun section(fieldIds: List<Int>): ByteArray {
        if (fieldIds.isEmpty()) return byteArrayOf(0)
        val ordered = ascendingDistinct(fieldIds)
        val maskBytes = ordered.last() / 8 + 1
        val out = ByteArray(1 + maskBytes)
        out[0] = maskBytes.toByte()
        for (id in ordered) {
            val index = 1 + id / 8
            out[index] = (out[index].toInt() or (1 shl (id % 8))).toByte()
        }
        return out
    }

    fun content(writes: List<RawFieldWrite>, readIds: List<Int>): ByteArray {
        val orderedWrites = writes.sortedBy { it.fieldId }
        val writeIds = ascendingDistinct(orderedWrites.map { it.fieldId })
        val out = ArrayList<Byte>()
        section(writeIds).forEach { out.add(it) }
        for (write in orderedWrites) {
            write.value().forEach { out.add(it) }
        }
        section(readIds).forEach { out.add(it) }
        return out.toByteArray()
    }

    private fun ascendingDistinct(fieldIds: List<Int>): List<Int> {
        val ordered = fieldIds.sorted()
        for (i in ordered.indices) {
            require(ordered[i] in 0..RawFieldWrite.MAX_FIELD_ID) { "field id ${ordered[i]} out of range" }
            require(i == 0 || ordered[i] != ordered[i - 1]) { "duplicate field id ${ordered[i]}" }
        }
        return ordered
    }
}

public class ReadWriteDataRequest private constructor(
    device: EquipmentDevice,
    public val reads: List<BikeField>,
) : EquipmentRequest(device, EquipmentCommand.READ_WRITE_DATA) {

    public val expectedDataLength: Int? =
        if (reads.all { it.isResolved }) reads.sumOf { it.width!! } else null

    override fun content(): ByteArray = ReadWriteDataCodec.content(emptyList(), reads.map { it.id })

    public fun decode(raw: ByteArray): ReadWriteDataResult {
        val frame = when (val parsed = EquipmentFrameCodec.parseResponse(raw, device, command)) {
            is FrameParseResult.Rejected -> return ReadWriteDataResult.Malformed(parsed.rejection, parsed.detail)
            is FrameParseResult.Accepted -> parsed.frame
        }
        when (frame.status) {
            EquipmentStatus.DONE -> Unit
            EquipmentStatus.SECURITY_BLOCK -> return ReadWriteDataResult.SecurityBlocked
            else -> return ReadWriteDataResult.StatusRejected(frame.status, frame.statusCode)
        }
        if (frame.dataLength == 0) return ReadWriteDataResult.FieldDataMissing
        val data = frame.data()
        val expected = expectedDataLength
            ?: return ReadWriteDataResult.Values(mapOf(reads.single() to FieldValue.Undecoded(data)))
        if (data.size != expected) return ReadWriteDataResult.LengthMismatch(expected, data.size)
        val readings = LinkedHashMap<BikeField, FieldValue>()
        var offset = 0
        for (field in reads) {
            val width = field.width!!
            readings[field] = FieldDecoder.decode(field, data.copyOfRange(offset, offset + width))
            offset += width
        }
        return ReadWriteDataResult.Values(readings)
    }

    internal companion object {
        fun create(device: EquipmentDevice, fields: Collection<BikeField>): ReadWriteDataRequest {
            require(fields.isNotEmpty()) { "read request must name at least one field" }
            val ordered = fields.sortedBy { it.id }
            require(ordered.distinct().size == ordered.size) { "read request contains duplicate fields" }
            require(ordered.all { it.isResolved } || ordered.size == 1) {
                "fields with unresolved encodings must be read alone: " +
                    ordered.filter { !it.isResolved }.joinToString()
            }
            val request = ReadWriteDataRequest(device, ordered)
            request.expectedDataLength?.let {
                require(EquipmentFrameCodec.MIN_RESPONSE_LENGTH + it <= EquipmentFrameCodec.MAX_MESSAGE_LENGTH) {
                    "expected response of ${EquipmentFrameCodec.MIN_RESPONSE_LENGTH + it} bytes exceeds message limit"
                }
            }
            request.encode()
            return request
        }
    }
}

internal object FieldDecoder {
    fun decode(field: BikeField, bytes: ByteArray): FieldValue {
        val encoding = field.encoding
        if (encoding is FieldEncoding.Unresolved) return FieldValue.Undecoded(bytes)
        if (bytes.all { (it.toInt() and 0xFF) == 0xFF }) return FieldValue.Sentinel
        return when (encoding) {
            is FieldEncoding.UnsignedLittleEndian -> {
                var value = 0L
                for (i in bytes.indices) value = value or ((bytes[i].toLong() and 0xFF) shl (8 * i))
                FieldValue.Number(value)
            }
            FieldEncoding.Flag -> when (bytes[0].toInt() and 0xFF) {
                0 -> FieldValue.Flag(false)
                1 -> FieldValue.Flag(true)
                else -> FieldValue.InvalidEncoding(bytes)
            }
            FieldEncoding.WorkoutModeCode -> FieldValue.Mode(bytes[0].toInt() and 0xFF)
            FieldEncoding.Unresolved -> FieldValue.Undecoded(bytes)
        }
    }
}

public sealed class ReadWriteDataResult {
    public class Values internal constructor(
        public val readings: Map<BikeField, FieldValue>,
    ) : ReadWriteDataResult() {
        override fun toString(): String = "Values($readings)"
    }

    public object SecurityBlocked : ReadWriteDataResult() {
        override fun toString(): String = "SecurityBlocked"
    }

    public class StatusRejected internal constructor(
        public val status: EquipmentStatus,
        public val statusCode: Int,
    ) : ReadWriteDataResult() {
        override fun toString(): String = "StatusRejected($status/$statusCode)"
    }

    public object FieldDataMissing : ReadWriteDataResult() {
        override fun toString(): String = "FieldDataMissing"
    }

    public class LengthMismatch internal constructor(
        public val expectedDataLength: Int,
        public val actualDataLength: Int,
    ) : ReadWriteDataResult() {
        override fun toString(): String = "LengthMismatch(expected=$expectedDataLength, actual=$actualDataLength)"
    }

    public class Malformed internal constructor(
        public val rejection: FrameRejection,
        public val detail: String,
    ) : ReadWriteDataResult() {
        override fun toString(): String = "Malformed($rejection: $detail)"
    }
}
