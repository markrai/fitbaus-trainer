// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.bikebridge.host

/**
 * U7: whether [com.fitbaus.bikebridge.protocol.EquipmentSecurity.hash] has been
 * independently shown to match this bike's Legacy hash helper.
 *
 * Live sessions stay [Unresolved]. NativeBridgeService never passes
 * [IndependentlyEstablished]; that value exists only so offline unit tests can
 * exercise VerifySecurity. A passing synthetic test is not a production enable.
 */
internal enum class SecurityHashCompatibility {
    Unresolved,
    IndependentlyEstablished,
}
