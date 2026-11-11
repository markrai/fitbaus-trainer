# Native Bike Bridge

Production Kotlin runtime for the ProForm Smart Power 10.0 equipment bridge.
Package `com.fitbaus.bikebridge` (production) or `com.fitbaus.bikebridge.native`
(staging). Architecture: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

| Module | Contents |
| --- | --- |
| `equipment-protocol` | Pure Kotlin/JVM framing, identity, security hash, HTTP JSON contract. No Android / USB / network. |
| `bridge-app` | Production Android host: USB session, AuthOnly init, HTTP, pairing, Arcade HUD. |
| `equipment-usb-probe` | Operator-triggered read-only USB diagnostic APK. |
| `:arcade` | Shared HUD library (`equipment-bridges/shared/arcade`). Passive; no USB or resistance writes. |

## Build and test

`:equipment-protocol` tests run on JDK 17+. Android modules need **JDK 21**,
Android SDK Platform 34, NDK 26.1.10909125, CMake 3.22.1, and
`local.properties` `sdk.dir=...`. Production signing keys are optional for
unit tests; set `bikebridge.signing.*` only when assembling a production APK.

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot"
.\gradlew.bat :equipment-protocol:test :bridge-app:testReleaseUnitTest :equipment-usb-probe:testDebugUnitTest :arcade:testDebugUnitTest
.\gradlew.bat :bridge-app:assembleRelease -PbridgeIdentity=production
```

Staging debug APK (WarmState when `unlockQualification=off`; skips
VerifySecurity, so it is a diagnostic / limited fallback, not a reliable
cold-controller control path):

```powershell
.\gradlew.bat :bridge-app:assembleDebug
```

Probe APK: `:equipment-usb-probe:assembleDebug`. Physical checklist:
[equipment-usb-probe/OPERATOR-PHYSICAL-ACCEPTANCE.md](equipment-usb-probe/OPERATOR-PHYSICAL-ACCEPTANCE.md).

## Production init

`bridgeIdentity=production` compiles `PRODUCTION_IDENTITY=true`. Unlock plan is
**AuthOnly** when DeviceInfo requires unlock, even if `unlockQualification=off`.
Gradle fails configure if production is combined with `auth` or `lockout`.

Staging `unlockQualification=off` stays WarmState: it skips VerifySecurity.
Use that APK only as a diagnostic / limited fallback. It does not reliably
provide resistance control from a cold controller. Production identity is
AuthOnly even when `unlockQualification=off`.

## Probe safety

- No automatic USB open/claim/transmit on Activity start, resume, or attach.
- `ReadOnlyTransmitGate` allows DeviceInfo / SystemInfo / VersionInfo / empty
  ReadWriteData reads only. VerifySecurity and nonempty writes are rejected.
- `claimInterface(..., false)` only.
- Identity values are redacted from reports.
- Logcat tag: `FITBAUS_EQUIPMENT_PROBE`. Production host tag:
  `FITBAUS_NATIVE_BRIDGE`.

## Licensing

Fitbaus-owned code is AGPL-3.0-only. Portions are adapted from STRIDE
(Apache-2.0); see [equipment-protocol/NOTICE](equipment-protocol/NOTICE) and
[equipment-protocol/licenses/](equipment-protocol/licenses/).
