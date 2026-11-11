// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class WriteResistanceTest {
    private val bike = EquipmentDevice.FITNESS_BIKE

    @Test
    fun encodesLegacyEquivalentField2WriteForLevel2AtBoardMax22() {
        val encoded = EquipmentRequests.writeResistance(bike, 2, 22).encode()
        assertEquals("07 09 02 01 04 5F 03 00 79", hex(encoded))
    }

    @Test
    fun encodesLegacyEquivalentField2WriteForLevel3AtBoardMax22() {
        val encoded = EquipmentRequests.writeResistance(bike, 3, 22).encode()
        assertEquals("07 09 02 01 04 25 05 00 41", hex(encoded))
    }

    @Test
    fun rejectsApplicationWindowAndUnknownBoardMax() {
        assertThrows(IllegalArgumentException::class.java) {
            EquipmentRequests.writeResistance(bike, 0, 22)
        }
        assertThrows(IllegalArgumentException::class.java) {
            EquipmentRequests.writeResistance(bike, 16, 22)
        }
        assertThrows(IllegalArgumentException::class.java) {
            EquipmentRequests.writeResistance(bike, 3, 0)
        }
    }

    @Test
    fun doneWithEmptyDataIsAcceptedAndSecurityBlockDoesNotUnlock() {
        val request = EquipmentRequests.writeResistance(bike, 3, 22)
        val done = statusFrame(bike.id, EquipmentCommand.READ_WRITE_DATA.id, EquipmentStatus.DONE.code!!)
        val accepted = request.decode(done)
        assertTrue(accepted is ResistanceWriteResult.Accepted)
        assertEquals(3, (accepted as ResistanceWriteResult.Accepted).level)

        val blocked = statusFrame(bike.id, EquipmentCommand.READ_WRITE_DATA.id, EquipmentStatus.SECURITY_BLOCK.code!!)
        assertTrue(request.decode(blocked) is ResistanceWriteResult.SecurityBlocked)
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
