# Bike Bridge architecture

Production Bike Bridge is the Kotlin Native app under `native/`. Package
`com.fitbaus.bikebridge` (versionName `0.2.0`) claims the ProForm Smart Power
10.0 brainboard USB, authenticates when DeviceInfo requires unlock, streams
Resistance / RPM / Watts, and serves a trusted-LAN HTTP API for FitBaus
Trainer.

Trainer remains the product. This tree is the model-specific equipment bridge.

## Modules

```text
native/
  equipment-protocol/   framing, identity, security hash, HTTP JSON contract
  bridge-app/           production Android host (USB, HTTP, pairing, Arcade)
  equipment-usb-probe/  operator-triggered read-only USB diagnostic APK
equipment-bridges/shared/arcade/   optional HUD; never owns USB or resistance
```

`equipment-protocol` is pure JVM. It must not import Android, USB, or network
types. NOTICE and STRIDE Apache-2.0 attributions ship in APK assets.

## USB session (production)

Production identity uses **AuthOnly** when DeviceInfo `requiresUnlock` is true
(Smart Power 10 `softwareVersion` 83 does):

1. DeviceInfo(MAIN=2); adopt the reply's PrimaryDevice (FitnessBike=7)
2. DeviceInfo confirm on the adopted primary
3. SystemInfo and VersionInfo on MAIN (replies addressed as device 7 are parsed)
4. One VerifySecurity on the primary; serial from DeviceInfo, part/model from
   MAIN SystemInfo, library from MAIN VersionInfo
5. MaxResistanceLevel read and periodic telemetry on the primary
6. Resistance writes (ReadWriteData command 2, field 2) only after the
   controller reports Unlocked

USB reconnect starts a new session: VerifySecurity is attempted once per
session and write readiness is not inherited from a previous connection.
AuthOnly was physically qualified on two staging cold boots (including R3).
The production APK has been verified on a warm controller (authentication
and advertised control), not as production R3 or cold-start qualification.
See [PROTOCOL.md](PROTOCOL.md).

Write-time controller status `SECURITY_BLOCK` fails closed. HTTP 200 means the
bike returned Done for that write; it is not proof the rider felt the load.
Observed resistance comes only from telemetry field 2.

Staging package `com.fitbaus.bikebridge.native` with `unlockQualification=off`
stays **WarmState**: it skips VerifySecurity. That is a diagnostic / limited
fallback, not a cold-start control path. On a cold controller it does not
reliably provide resistance writes (`SECURITY_BLOCK`). Gradle flags
`unlockQualification=auth|lockout` are staging-only experiments and cannot
be combined with `bridgeIdentity=production`.

## HTTP (trusted LAN)

Bind `0.0.0.0:8765`. Intended network is a trusted LAN only. Do not expose the
console to the public Internet.

| Method | Path | Auth | Role |
| --- | --- | --- | --- |
| GET | `/health`, `/api/v1/health` | none | listener health |
| GET | `/api/v1/status` | none | connection, control availability, requested vs observed |
| GET | `/api/v1/telemetry` | none | observed resistance / RPM / watts |
| POST | `/api/v1/resistance` | `X-Fitbaus-Token` | absolute integer 1–15 |
| POST | `/api/v1/heartrate` | `X-Fitbaus-Token` | display ingest only (30–250 BPM) |
| POST | `/api/v1/brightness` | `X-Fitbaus-Token` | Activity window percent 0–100 |
| OPTIONS | control routes | none | CORS preflight including the pairing header |

`resistanceControlAvailable` is true only when USB is connected, the session is
initialized, and the machine can set resistance. Board `maxResistanceLevel`
(observed 22 on this bike) is reported and used as the codec denominator; it
is not the HTTP acceptance window.

The surface does not expose incline, calibration, firmware, bootloader,
relative ± resistance, ramping, or raw USB.

## Pairing

Control POSTs require the console pairing token in `X-Fitbaus-Token`. The token
is an 8-character value shown grouped as `XXXX XXXX`. GET telemetry/status/health
do not require it. There is no runtime flag that can turn authentication or
unlock qualification on or off.

## Isolation

Do not run Bike Bridge and stock iFIT (`com.ifit.standalone` / `com.ifit.eru`)
at the same time. They cannot share the USB interface. Isolation is an
operator/adb step; the app does not kill, disable, or uninstall stock packages.

## Signing

Production APKs must be signed with the same certificate as the previously
installed `com.fitbaus.bikebridge` package so in-place `adb install -r` can
preserve pairing data. Keystores are not committed. See `native/local.properties`
keys `bikebridge.signing.*`.
