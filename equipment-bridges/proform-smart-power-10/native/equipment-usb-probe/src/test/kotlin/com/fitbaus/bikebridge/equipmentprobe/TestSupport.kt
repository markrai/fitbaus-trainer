// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.equipmentprobe

import com.fitbaus.bikebridge.equipmentprobe.usb.BikeUsbConstants
import com.fitbaus.bikebridge.equipmentprobe.usb.OpenResult
import com.fitbaus.bikebridge.equipmentprobe.usb.ProbeTransport
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportFailureClass
import com.fitbaus.bikebridge.equipmentprobe.usb.TransportResult
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbDeviceSnapshot
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbEndpointSnapshot
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbHostGateway
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbInterfaceSnapshot
import com.fitbaus.bikebridge.equipmentprobe.usb.UsbQualificationResult
import com.fitbaus.bikebridge.protocol.EquipmentCommand
import com.fitbaus.bikebridge.protocol.EquipmentDevice
import com.fitbaus.bikebridge.protocol.EquipmentFrameCodec
import com.fitbaus.bikebridge.protocol.EquipmentStatus
import java.util.ArrayDeque

internal fun hex(text: String): ByteArray {
    val clean = text.replace(" ", "")
    return ByteArray(clean.length / 2) { clean.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

internal fun response(
    device: EquipmentDevice = EquipmentDevice.MAIN,
    command: EquipmentCommand,
    status: EquipmentStatus,
    data: ByteArray = ByteArray(0),
): ByteArray {
    val length = EquipmentFrameCodec.RESPONSE_HEADER_LENGTH + data.size + 1
    val frame = ByteArray(length)
    frame[0] = device.id.toByte()
    frame[1] = length.toByte()
    frame[2] = command.id.toByte()
    frame[3] = status.code!!.toByte()
    data.copyInto(frame, 4)
    frame[length - 1] = EquipmentFrameCodec.checksum(frame, length).toByte()
    return frame
}

internal fun matchingBrainboard(
    name: String = "bike0",
    vendorId: Int = BikeUsbConstants.VENDOR_ID,
    productId: Int = BikeUsbConstants.PRODUCT_ID,
    interfaceClass: Int = BikeUsbConstants.INTERFACE_CLASS_HID,
    inAddress: Int = BikeUsbConstants.IN_ENDPOINT_ADDRESS,
    outAddress: Int = BikeUsbConstants.OUT_ENDPOINT_ADDRESS,
    inType: Int = BikeUsbConstants.ENDPOINT_TYPE_INTERRUPT,
    outType: Int = BikeUsbConstants.ENDPOINT_TYPE_INTERRUPT,
    packetSize: Int = BikeUsbConstants.PACKET_SIZE,
): UsbDeviceSnapshot = UsbDeviceSnapshot(
    deviceName = name,
    vendorId = vendorId,
    productId = productId,
    interfaces = listOf(
        UsbInterfaceSnapshot(
            id = BikeUsbConstants.INTERFACE_NUMBER,
            interfaceClass = interfaceClass,
            endpoints = listOf(
                UsbEndpointSnapshot(inAddress, directionIn = true, type = inType, maxPacketSize = packetSize),
                UsbEndpointSnapshot(outAddress, directionIn = false, type = outType, maxPacketSize = packetSize),
            ),
        ),
    ),
)

internal class ScriptedTransport(
    responses: List<TransportResult>,
    private var attached: Boolean = true,
) : ProbeTransport {
    private val queue = ArrayDeque(responses)
    val sent = ArrayList<ByteArray>()
    var closed: Boolean = false
        private set
    private val allowlist = com.fitbaus.bikebridge.equipmentprobe.policy.TransmitAllowlist()

    override fun transmitAllowlist() = allowlist

    override fun exchange(request: ByteArray): TransportResult {
        sent += request.copyOf()
        if (!attached) return TransportResult.Failed(TransportFailureClass.DEVICE_DETACHED)
        if (queue.isEmpty()) return TransportResult.Failed(TransportFailureClass.IN_TIMEOUT_OR_FAILURE)
        return queue.removeFirst()
    }

    override fun isAttached(): Boolean = attached && !closed

    override fun close() {
        closed = true
        attached = false
        allowlist.resetToMainOnly()
    }

    fun detach() {
        attached = false
    }
}

internal class FakeUsbGateway(
    private var devices: List<UsbDeviceSnapshot>,
    private val permission: MutableMap<String, Boolean> = mutableMapOf(),
    private val openHandler: (UsbQualificationResult.Qualified) -> OpenResult,
) : UsbHostGateway {
    var openCalls: Int = 0
        private set

    override fun listDevices(): List<UsbDeviceSnapshot> = devices

    override fun hasPermission(deviceName: String): Boolean = permission[deviceName] == true

    override fun openQualified(qualified: UsbQualificationResult.Qualified): OpenResult {
        openCalls += 1
        return openHandler(qualified)
    }

    fun grant(deviceName: String) {
        permission[deviceName] = true
    }

    fun deny(deviceName: String) {
        permission[deviceName] = false
    }

    fun setDevices(next: List<UsbDeviceSnapshot>) {
        devices = next
    }
}

internal val identityHappyPathResponses: List<ByteArray> = listOf(
    // bootstrap DeviceInfo(MAIN) + confirmation DeviceInfo(MAIN)
    hex("02 0B 81 02 56 00 15 CD 5B 07 2A"),
    hex("02 0B 81 02 56 00 15 CD 5B 07 2A"),
    hex("02 10 82 02 00 00 00 AF 9C 00 00 52 1F 06 00 58"),
    hex("02 06 84 02 54 E2"),
)

/** Retarget a valid response frame to another device id and refresh checksum. */
internal fun retargetFrame(frame: ByteArray, deviceId: Int): ByteArray {
    val declared = frame[1].toInt() and 0xFF
    val out = frame.copyOf(declared)
    out[0] = deviceId.toByte()
    out[declared - 1] = EquipmentFrameCodec.checksum(out, declared).toByte()
    return out
}

internal fun legacyFitnessBikeDeviceInfo(
    softwareVersion: Int = 86,
    serial: Long = 0x0A0B0C0DL,
    sectionCount: Int = 15,
): ByteArray {
    val dataLen = 1 + 1 + 4 + 2 + 1 + sectionCount
    val length = EquipmentFrameCodec.RESPONSE_HEADER_LENGTH + dataLen + 1
    val frame = ByteArray(length)
    frame[0] = 7
    frame[1] = length.toByte()
    frame[2] = EquipmentCommand.DEVICE_INFO.id.toByte()
    frame[3] = EquipmentStatus.DONE.code!!.toByte()
    var i = 4
    frame[i++] = softwareVersion.toByte()
    frame[i++] = 1
    frame[i++] = (serial and 0xFF).toByte()
    frame[i++] = ((serial ushr 8) and 0xFF).toByte()
    frame[i++] = ((serial ushr 16) and 0xFF).toByte()
    frame[i++] = ((serial ushr 24) and 0xFF).toByte()
    frame[i++] = 1
    frame[i++] = 0
    frame[i++] = sectionCount.toByte()
    repeat(sectionCount) { frame[i++] = 0x01 }
    frame[length - 1] = EquipmentFrameCodec.checksum(frame, length).toByte()
    return frame
}

internal val telemetryHappyPathResponses: List<ByteArray> = listOf(
    hex("02 09 02 02 96 00 48 00 ED"),
    response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(24)),
    response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(2)),
    response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(1)),
    response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(5)),
    response(command = EquipmentCommand.READ_WRITE_DATA, status = EquipmentStatus.DONE, data = byteArrayOf(5)),
)

internal fun basicSuccessTransport(): ScriptedTransport =
    ScriptedTransport((identityHappyPathResponses + telemetryHappyPathResponses).map { TransportResult.Ok(it) })

/** Extended unit tests assume a session that already confirmed PrimaryDevice. */
internal fun ScriptedTransport.withConfirmedPrimary(
    deviceId: Int = EquipmentDevice.MAIN.id,
): ScriptedTransport {
    val allowlist = transmitAllowlist()!!
    allowlist.beginAwaitingConfirmation(deviceId)
    allowlist.confirmSessionPrimary(deviceId)
    return this
}
