// SPDX-License-Identifier: AGPL-3.0-only
// Portions adapted from STRIDE (https://github.com/keranm/strideApp, commit d9e1b53),
// Copyright 2026 The Idea Works, Apache License 2.0. Modified by Fitbaus. See NOTICE.

package com.fitbaus.bikebridge.protocol

public sealed class EquipmentRequest(
    public val device: EquipmentDevice,
    public val command: EquipmentCommand,
) {
    internal abstract fun content(): ByteArray

    public fun encode(): ByteArray = EquipmentFrameCodec.encodeRequest(device, command, content())
}

public object EquipmentRequests {
    public fun deviceInfo(device: EquipmentDevice = EquipmentDevice.MAIN): DeviceInfoRequest =
        DeviceInfoRequest.create(device)

    public fun systemInfo(device: EquipmentDevice = EquipmentDevice.MAIN): SystemInfoRequest =
        SystemInfoRequest.create(device)

    public fun versionInfo(device: EquipmentDevice = EquipmentDevice.MAIN): VersionInfoRequest =
        VersionInfoRequest.create(device)

    public fun verifySecurity(
        identity: MachineIdentity,
        device: EquipmentDevice = EquipmentDevice.MAIN,
    ): VerifySecurityRequest = VerifySecurityRequest.create(device, identity)

    public fun read(device: EquipmentDevice, fields: Collection<BikeField>): ReadWriteDataRequest =
        ReadWriteDataRequest.create(device, fields)

    public fun writeResistance(
        device: EquipmentDevice,
        level: Int,
        maxResistanceLevel: Int,
    ): WriteResistanceRequest = WriteResistanceRequest.create(device, level, maxResistanceLevel)

    public fun writeIdleModeLockout(device: EquipmentDevice): WriteIdleModeLockoutRequest =
        WriteIdleModeLockoutRequest.create(device)
}
