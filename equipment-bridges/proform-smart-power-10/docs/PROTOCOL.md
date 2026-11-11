# Smart Power 10 USB protocol notes

Facts that Native Bike Bridge relies on for this console. Implementation in
`native/equipment-protocol` and `native/bridge-app` is the source of truth.

## Hardware

| Item | Value |
| --- | --- |
| Console | ProForm Smart Power 10.0 only |
| Android | 5.1.1 / API 22, ABI x86 (`byt_t_crv2`) |
| Brainboard USB | VID `8508`, normal PID `2`, bootloader PID `153`, interface `0` |
| Observed softwareVersion | 83 |
| PrimaryDevice | FitnessBike = 7 |
| Board MaxResistanceLevel | 22 |
| Application write window | HTTP and codec writes 1–15 |

`requiresUnlock` is true when softwareVersion > 75.

## Commands Native sends (AuthOnly)

Device targeting: identity collection on MAIN (2); VerifySecurity and
resistance/telemetry on PrimaryDevice 7.

| Step | Command | Device | Notes |
| --- | --- | --- | --- |
| DeviceInfo | 129 | MAIN, then 7 | Adopt PrimaryDevice from MAIN reply; confirm on 7 |
| SystemInfo | 130 | MAIN | Part/model for the unlock hash |
| VersionInfo | 132 | MAIN | Library / mlv for the unlock hash |
| VerifySecurity | 144 | 7 | Once per USB session when unlock is required |
| ReadWriteData | 2 | 7 | Field 2 resistance write; empty reads; telemetry poll |

MAIN SystemInfo/VersionInfo replies may be addressed as device 7; Native parses
those the same way DeviceInfo bootstrap already adopts device 7.

Native does **not** send SupportedDevices, SupportedCommands, or
IdleModeLockout on the production AuthOnly path. Staging `lockout` remains an
experiment.

Example production R3 write (field 2 at board max 22):

```text
07 09 02 01 04 25 05 00 41
```

Controller status 8 is `SECURITY_BLOCK`. After a transmitted write returns
that status, Native fails closed and does not treat the session as writable.

## Hash and authentication

Unlock material is serial from DeviceInfo, part/model from MAIN SystemInfo,
and library from MAIN VersionInfo. Native computes that payload with
`EquipmentSecurity.hash()` in `equipment-protocol`.

Two related facts must not be collapsed:

- **AuthOnly** sends one VerifySecurity during USB init when DeviceInfo
  requires unlock. Write readiness still requires Unlocked in that session.
  USB reconnect authenticates once per new session. The sequence itself was
  physically qualified on **two staging cold boots** (controller Unlocked,
  HTTP 200, fresh observed R3, operator-confirmed load). The **production**
  identity APK has been verified on a **warm** controller (successful
  authentication and advertised control). That is not a claim of production
  R3 or operator-confirmed load, and it is not production cold-start
  qualification; a separate production-specific cold boot is still required
  before claiming that.
- **`SecurityHashCompatibility.Unresolved`** is the production default. It
  means Native has not independently classified the hash as matching a Legacy
  helper for the write-time SECURITY_BLOCK recovery path, so that recovery
  path does not send VerifySecurity. Unresolved does **not** disable AuthOnly
  init. `IndependentlyEstablished` exists only so offline tests can exercise
  recovery; it is not a production default and is not implied by a passing
  AuthOnly session.

## Isolation from iFIT

Stock `com.ifit.standalone` (Wolf) and `com.ifit.eru` must be stopped before
Native claims interface 0. Native does not talk to those packages.
