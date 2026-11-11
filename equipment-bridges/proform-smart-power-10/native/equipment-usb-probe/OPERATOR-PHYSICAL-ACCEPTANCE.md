# F2 Equipment USB Probe — operator physical acceptance (later)

Do not run this procedure until the offline APK review is complete. This document
is the later hardware checklist; this F2 deliverable was not installed or run on
the bike during implementation.

Bike ADB serial used below:

`<console>:5555`

Every `adb` command must include `-s <console>:5555`. Do not target any other
attached Android device (phones, Kindles, emulators). Substitute the console's
ADB address; do not assume a private LAN IP.

## Preconditions

1. Rider off the bike.
2. Confirm the bike identity before installation:

```text
adb -s <console>:5555 get-state
adb -s <console>:5555 shell getprop ro.product.device
adb -s <console>:5555 shell getprop ro.build.version.sdk
```

Expected: device `byt_t_crv2`, SDK `22`.

3. Force-stop competing owners on the bike only:

```text
adb -s <console>:5555 shell am force-stop com.ifit.standalone
adb -s <console>:5555 shell am force-stop com.ifit.eru
adb -s <console>:5555 shell am force-stop com.fitbaus.bikebridge
```

4. Prefer running soon after a normal Bike Bridge session (board may still be
   unlocked from that session).

## Install (operator-controlled; not performed in F2 implementation)

```text
adb -s <console>:5555 install -r equipment-usb-probe/build/outputs/apk/debug/equipment-usb-probe-debug.apk
adb -s <console>:5555 shell am start -n com.fitbaus.bikebridge.equipmentprobe/.ProbeActivity
```

## Passive UI check

Confirm the Activity shows app identity/version, USB detection, descriptor
qualification, and permission state **without** opening or talking to the
brainboard.

## Basic read-only probe

1. Tap **Run Read-Only Probe** once.
2. Grant USB permission if prompted (app-owned action).
3. Confirm logcat on the bike:

```text
adb -s <console>:5555 logcat -s FITBAUS_EQUIPMENT_PROBE
```

4. Pull the report from app external files:

```text
adb -s <console>:5555 pull /sdcard/Android/data/com.fitbaus.bikebridge.equipmentprobe/files/ .
```

5. Verify the report redacts serial/part/model and never shows VerifySecurity.
6. Extended observation stays disabled unless the basic run completed with
   `StopKind.NONE`, identity qualified, and telemetry qualified.
7. If claimInterface(force=false) fails, stop and treat force-claim as an
   unresolved review item — do not change policy on the bike ad hoc.

## Extended observation (optional)

Only after a fully successful basic probe:

1. Tap **Run Extended Observation**.
2. Pedal and change resistance with **physical keys only**.
3. Expect at most 2 USB requests/second overall for up to 60 seconds (budget 120).
   Fields rotate Watts+Rpm, Resistance, ActualResistance — about 2/3 Hz each,
   not 2 Hz per field.
4. Confirm the app never changes resistance or workout state.
5. Stop on SecurityBlock, detach, budget exhaustion, or cancel.

## Aftercare / Bike Bridge restoration

1. Force-stop or uninstall the probe on the bike:

```text
adb -s <console>:5555 shell am force-stop com.fitbaus.bikebridge.equipmentprobe
```

Optional uninstall:

```text
adb -s <console>:5555 uninstall com.fitbaus.bikebridge.equipmentprobe
```

2. Restart Bike Bridge on the bike and confirm normal
   `/api/v1/telemetry` behaviour.
3. Record U1/U2/U6/U10/U11 answers from the report; capture U3/U5 raw bytes only
   if the board was unlocked.

## F2.1 — DeviceInfo MALFORMED_FRAME follow-up (single basic probe)

After installing a build that includes structural RX diagnostics, run **one** basic
probe and pull the report. Do not enable extended observation, auth, or force-claim.

Confirm the DeviceInfo RX line records all of:

- `transferLength` (actual `bulkTransfer` read count)
- `declaredLength`
- `checksumEvaluated` / `checksumValid` (distinct; checksum may pass while device/command fail)
- `frameRejection` / `frameRejectionDetail` (exact codec rejection, not only `MALFORMED_FRAME`)
- `headerDeviceId` / `headerCommandId` / `headerStatusCode`
- `trailingPaddingBytes` / `trailingPaddingAllZero`
- `parse=Rejected(MALFORMED_FRAME: …)` including the nested frame rejection

Also confirm TX still shows `command=DEVICE_INFO … bytes=4`.

The report must still redact serial/part/model and must not dump unrestricted
identity payload hex. Those structural fields alone decide the next code change
(stale IN vs checksum vs command mismatch vs padding interpretation).

## F2.2 — DeviceInfo DEVICE_MISMATCH / device 7 (investigation outcome)

Offline conclusion (no protocol TX change yet):

- Equipment catalog `FITNESS_BIKE = 7`; Legacy HTTP reports `type=Bike`.
- Smart Power 10 Legacy logs report `type=Bike`.
- Legacy `DeviceInfoCmd(Main)` **adopts** the response device byte as
  `PrimaryDevice`; it does not enforce request/response device equality.
- F2.1 RX (`headerDeviceId=7`, `declaredLength=29`, checksum OK, command 129,
  status Done) matches a Legacy-shaped DeviceInfo on FitnessBike, not a MAIN
  frame. Kotlin correctly reports `DEVICE_MISMATCH` while expecting MAIN.
- Non-zero bytes after offset 29 are outside the declared frame (HID report
  slack / leftover); they are not required to be zero and are not part of the
  checksum.

## F2.3 — PrimaryDevice bootstrap (controlled physical acceptance)

Build includes Legacy-compatible bootstrap for **Basic Probe only**:

1. TX `DeviceInfo(MAIN)` under authorization `MAIN_ONLY` (`02 04 81 87`).
2. If RX is Done DeviceInfo from `FitnessBike=7` with valid checksum/identity,
   enter provisional `AWAITING_CONFIRMATION(7)` — only DeviceInfo(7) is
   permitted (decoder remains strict; bootstrap policy is explicit).
3. Confirmation TX `DeviceInfo(FitnessBike)`; require same softwareVersion/serial.
4. Only after successful confirmation enter `CONFIRMED(7)` and emit
   `PRIMARY_DEVICE_ADOPTED … confirmed=true`. Failed confirmation resets to
   `MAIN_ONLY` and must not report a confirmed PrimaryDevice.
5. Subsequent SystemInfo / VersionInfo / ReadWriteData target PrimaryDevice 7.

**Physical-hardware assumptions (no speculative fallbacks in this APK):**

- Confirmation `DeviceInfo(FitnessBike)` is expected to succeed on the live board
  after a valid MAIN→7 adoption. There is no alternate confirm path and no
  retry/fallback request set.
- After adoption, `SystemInfo` and `VersionInfo` are sent unconditionally to the
  session PrimaryDevice (same as Legacy after PrimaryDevice is set). If the board
  returns DeviceNotSupported / malformed, the probe records that stop; it does
  **not** fall back to MAIN or invent other command sequences.

**Extended Observation (F2.3):** explicitly **disabled**. A successful Basic Probe
must not authorize device 7 (or any PrimaryDevice) in a newly opened USB session
from the previous Basic PrimaryDevice id alone. Extended stays refused until a
future build performs its own bounded DeviceInfo bootstrap/confirmation inside
that new session.

Expected Basic report tokens:

- `parse=BootstrapAdopted(MAIN->7 (FITNESS_BIKE))` on first RX
- `PRIMARY_DEVICE_ADOPTED … fromResponseDeviceMismatch=true confirmed=true`
- later TX lines show `device=7`
- no VerifySecurity, no force-claim, serial/part/model still redacted

Run **one** Basic Probe only after installing this APK. Do not expect Extended
to become available after Basic `StopKind.NONE` in F2.3.

## F2.3 — Physical acceptance result (2026-11-08)

**Outcome A — full success** on ProForm Smart Power 10 (`byt_t_crv2`, API 22).

Evidence (operator machine temp; not committed):

- Dir: `%TEMP%\f2.3-physical-20261108-102533`
- Report: `equipment-probe-basic-20261108-152543.txt`

| Check | Result |
| --- | --- |
| StopKind | `NONE` |
| PrimaryDevice | FitnessBike=7, `confirmed=true`, `softwareVersion=83` |
| Identity | Qualified (identifiers present and redacted) |
| Telemetry | Qualified (Watts=0, Rpm=0 at rest) |
| Requests | 10 / 12 |
| Extended | Disabled (button stayed disabled; not run) |
| Actuation / VerifySecurity | Not used |
| Legacy recovery | Probe force-stopped; Legacy pid reopened `/dev/bus/usb/001/007`; telemetry `connected=true initialized=true type=Bike` |

Observed Basic sequence (device 7 after confirm):

1. DeviceInfo(MAIN) → BootstrapAdopted(MAIN→7)
2. DeviceInfo(7) → ConfirmParsed → PRIMARY_DEVICE_ADOPTED confirmed=true
3. SystemInfo(7) → Parsed
4. VersionInfo(7) → Parsed
5. ReadWriteData Watts+Rpm → Number(0), Number(0)
6. MaxResistanceLevel → Number(22)
7. WorkoutMode → Mode(1 IDLE)
8. IdleModeLockout → Flag(true)
9. Resistance alone → undecoded raw `5F 03` (2 data bytes)
10. ActualResistance alone → undecoded raw `98 08` (2 data bytes)

**Scope closed by this run:** F2.3 Basic read-only PrimaryDevice bootstrap + identity/telemetry qualification.
**U3 closed offline after F2.3:** `ResistanceCodec` matches F2.3 physical raw `5F 03` / `98 08` at board max 22 (u16 LE, `step=10000/max`).
**Not closed by F2.3:** U4 (Legacy HTTP resistance vs field 2 vs 18 under load), Extended Observation, unlock (F3), actuation (F5).

## F2.4 — Dynamic telemetry comparison

Goal: cross-check Bike Bridge HTTP telemetry vs probe **Dynamic Observation** for Watts, RPM, Resistance (field 2), and ActualResistance (field 18) **without simultaneous USB ownership** and **without resistance writes**.

### Why not Basic Probe alone

Basic Probe is a ≤12-request snapshot. F2.4 needs a bounded multi-second sample stream. Use **Dynamic Observation** (`ProbePhase.DYNAMIC`): fresh DeviceInfo(MAIN) bootstrap + DeviceInfo(7) confirm in the **same** USB session, then rotate Watts+Rpm / Resistance / ActualResistance (~2 Hz overall, 500 ms spacing, 90 s / 200-request budget defaults). Never reuse Basic authorization.

### Resistance windows (do not conflate)

| Window | Value | Role |
| --- | --- | --- |
| Board `MaxResistanceLevel` | **22** (F2.3 observed) | Codec denominator (`step=10000/max`) |
| Fitbaus application write window | **1..15** (`ResistanceLimits`) | HTTP POST / write acceptance only; not used as codec max |

### Constraints

- Never open the probe while Bike Bridge holds the brainboard FD.
- Never issue `POST /api/v1/resistance` or any WriteData during the comparison.
- Prefer physical keys for resistance steps; pedaling for RPM/Watts.
- Record **measured** values; do not assume target cadence/resistance was achieved.
- Switch USB owners **only while idle** (RPM≈0). Never during active pedaling.
- No VerifySecurity / calibration / force-claim changes.
- Restore Bike Bridge after the probe pass if it was the USB owner.

### Probe launch extras

```text
am start -n com.fitbaus.bikebridge.equipmentprobe/.ProbeActivity \
  --es auto_run dynamic --es stage <label> --el duration_ms <ms>
```

Dynamic Observation remains operator-triggered from the probe APK. Do not run it while Bike Bridge holds USB.
