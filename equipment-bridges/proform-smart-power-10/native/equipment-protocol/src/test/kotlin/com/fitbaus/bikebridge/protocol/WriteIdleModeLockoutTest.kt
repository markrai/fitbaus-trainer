// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class WriteIdleModeLockoutTest {
    private val bike = EquipmentDevice.FITNESS_BIKE

    @Test
    fun encodesField95FlagTrueWithEmptyReadSection() {
        val encoded = EquipmentRequests.writeIdleModeLockout(bike).encode()
        assertEquals(EquipmentDeviceIds.FITNESS_BIKE, encoded[0].toInt() and 0xFF)
        assertEquals(EquipmentCommand.READ_WRITE_DATA.id, encoded[2].toInt() and 0xFF)
        assertEquals(12, encoded[3].toInt() and 0xFF)
        for (i in 4..14) {
            assertEquals(0, encoded[i].toInt() and 0xFF, "mask byte at $i")
        }
        assertEquals(0x80, encoded[15].toInt() and 0xFF)
        assertEquals(0x01, encoded[16].toInt() and 0xFF)
        assertEquals(0x00, encoded[17].toInt() and 0xFF)
        assertEquals(encoded.size, encoded[1].toInt() and 0xFF)
    }

    @Test
    fun doneIsAcceptedAndSecurityBlockDoesNotUnlock() {
        val request = EquipmentRequests.writeIdleModeLockout(bike)
        val done = statusFrame(bike.id, EquipmentCommand.READ_WRITE_DATA.id, EquipmentStatus.DONE.code!!)
        assertTrue(request.decode(done) is IdleModeLockoutWriteResult.Accepted)

        val blocked = statusFrame(bike.id, EquipmentCommand.READ_WRITE_DATA.id, EquipmentStatus.SECURITY_BLOCK.code!!)
        assertTrue(request.decode(blocked) is IdleModeLockoutWriteResult.SecurityBlocked)
    }

    private fun statusFrame(deviceId: Int, command: Int, status: Int): ByteArray {
        val length = EquipmentFrameCodec.RESPONSE_HEADER_LENGTH + 1
        val frame = ByteArray(length)
        frame[0] = deviceId.toByte()
        frame[1] = length.toByte()
        frame[2] = command.toByte()
        frame[3] = status.toByte()
        frame[length - 1] = EquipmentFrameCodec.checksum(frame, length).toByte()
        return frame
    }
}
