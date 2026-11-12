# FitBaus equipment bridge for ProForm Smart Power 10.0

Trusted-LAN Android bridge for **one** machine: the **ProForm Smart Power 10.0**
console. Native Kotlin claims the bike USB interface while stock iFIT is
stopped, authenticates when the board requires unlock, exposes Resistance /
RPM / Watts telemetry, and serves a small HTTP API on the local network.

This is an **equipment bridge**, not a stand-alone flagship product. FitBaus
Trainer is the product. This tree is intended to live under:

```text
equipment-bridges/proform-smart-power-10/
```

## Target hardware (exact)

| Item | Value |
| --- | --- |
| Console | ProForm Smart Power 10.0 only |
| Android | 5.1.1 / API 22 |
| ABI | x86 (`byt_t_crv2`) |
| Stock packages | `com.ifit.standalone` (Wolf), `com.ifit.eru`, `com.ifit.launcher` |
| Brainboard USB | VID `8508`, normal PID `2`, bootloader PID `153`, interface `0` |
| Production package | `com.fitbaus.bikebridge` (`0.2.0`) |

**Not claimed:** generic ProForm, generic exercise bikes, other iFIT equipment,
or modern 64-bit Android consoles.

## USB ownership

Do not run this bridge and Wolf at the same time. They cannot share the USB
interface.

- **Stock mode:** `com.ifit.standalone` owns USB.
- **FitBaus mode:** stop Wolf (and ERU), then launch this app. Do not uninstall Wolf.

This app does **not** kill, disable, or uninstall stock packages. Isolation is
an operator/adb step.

## Current capabilities

Kotlin sources and Native unit tests define behavior. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PROTOCOL.md](docs/PROTOCOL.md).

### Trusted-LAN HTTP (`0.0.0.0:8765`)

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/health` | Listener health + connection flags |
| `GET` | `/api/v1/status` | Bridge / machine status |
| `GET` | `/api/v1/telemetry` | Observed resistance / RPM / watts |
| `POST` | `/api/v1/resistance` | Absolute integer resistance request (pairing token) |
| `POST` | `/api/v1/heartrate` | Display-only HR ingest (pairing token) |
| `POST` | `/api/v1/brightness` | Console **window** brightness (pairing token) |

Control POSTs require header `X-Fitbaus-Token` matching the 8-character token
shown on the pairing screen (`XXXX XXXX`). GET routes do not. Bind is on all
interfaces for LAN reachability. **Trusted local network only. Do not expose
to the public Internet.** Resistance control moves physical machine load.

The surface does **not** expose arbitrary USB, incline, calibration, firmware,
bootloader, relative ± resistance, ramping, or workout-control APIs.

### Resistance control

- Accepted body: absolute integer **1–15** (`ResistanceLimits`).
- Board `maxResistanceLevel` is observed **22** on this bike and is the codec
  denominator, not the HTTP window.
- Production identity uses AuthOnly: one VerifySecurity when DeviceInfo
  requires unlock. Writes are allowed only after the controller is Unlocked.
  Staging AuthOnly was qualified on two cold boots (including R3). The
  production APK has been verified on a warm controller (authentication and
  advertised control), not as production R3 or a production cold start.
- Staging WarmState (`unlockQualification=off`) skips VerifySecurity. It is a
  diagnostic / limited fallback and does not reliably write resistance from a
  cold controller.
- A transmitted write that returns `SECURITY_BLOCK` fails closed.
- HTTP 200 means the bike accepted that write (Done). It is **not** proof the
  physical bike has reached that resistance. Observed resistance comes only
  from telemetry field 2.

### Heart rate and brightness

- HR: display ingest only (30–250 BPM); never initializes USB or changes resistance.
- Brightness: Activity window percent 0–100; never bike control. Last accepted
  value is persisted and reapplied when the Bridge Activity becomes visible.

## Security boundary

| Fact | |
| --- | --- |
| Control POST auth | Pairing token (`X-Fitbaus-Token`) |
| GET telemetry/status | Unauthenticated on the trusted LAN |
| Intended network | Trusted LAN only |
| Public Internet | **Must not** be exposed |
| Resistance POST | Physical-machine action |

## Repository layout

- `native/` — production Kotlin Bike Bridge (protocol, host, USB probe)
- `docs/` — architecture, protocol, Freestyle diagnostic, retired-host note
- `scripts/` — operator helpers (APK identity, bounded resistance actuation)

Arcade lives in `equipment-bridges/shared/arcade/` and is linked from Native.
It does not own USB or resistance.

## Arcade games

The console title bar has a DASHBOARD tab and four game tabs: BRICKS, MATH,
FLAK RUN and TRAIL RIDE. The exercise HUD (RPM, watts, resistance, HR) stays
above every game. Games only **read** cadence telemetry. They never send
resistance, change workouts or bike modes, or touch the USB session, and
switching games never restarts the bridge service. Only one camera pipeline
runs at a time.

### TRAIL RIDE

A first-person mountain-bike ride through an endless forest. The trail
winds procedurally and gets gradually harder (sharper bends, then tree
gates and slaloms).

- **Steer with your head.** Look at the screen and hold still for about a
  second while it centers, then lean your head slightly left or right. The
  bike moves toward that side at a limited speed. Holding your head still
  does **not** follow the bends: you steer through every curve.
- **Pedal to ride.** The world only moves while fresh RPM shows you
  pedaling (20 RPM or more). Speed varies modestly with cadence (about
  40-100 RPM); a faster baseline is never required. If you stop, the game
  shows `PEDAL TO RIDE` and waits.
- **Stay on the trail and miss the trees.** Riding past the trail edge for
  about 0.3 s, hitting a trunk or rock, or falling into a ditch is a crash:
  a short pause, a slow restart and two seconds of protection, then the ride
  carries on. There is no game over; the HUD counts your crashes.
  Orange edges and `STEER LEFT` / `STEER RIGHT` warn you near the edge.
- **Jump ditches with a pedal surge.** Ditches span the whole trail, marked
  by orange flags; steering cannot avoid them. When `SURGE NOW!` appears
  (about 1.7 s before the ditch), pedal clearly faster: by default 12 RPM
  above the pace the game learned at the start. The surge must be confirmed
  by fresh samples (about 0.5-0.75 s), and the jump only counts if it is
  confirmed between 1.25 s and 0.12 s before the ditch. A surge that is too
  early or too late fails. Each jump needs a new surge: ease off to rearm
  (`EASE OFF TO REARM` on the meter).
- **Holds.** Starting the camera, a lost face, missing or stale bike data,
  stopping pedaling, and the first ~3 s while it learns your pace all
  freeze the game; nothing advances and no life is lost while held. After
  the face returns it waits about 0.6 s for a stable view.
- **Score.** Points for distance, each obstacle passed, each ditch cleared
  (+150) and each new level. The ride is endless; scores are session-only.
  `Restart ride now` in the developer options starts a fresh ride.

**Developer options** (long-press the TRAIL RIDE tab):

| Option | Effect |
| --- | --- |
| Face 10 Hz / 15 Hz | Face tracker preset. TRAIL RIDE keeps its own preference, separate from FLAK RUN. Default 10 Hz, 1 thread. |
| Head sensitivity | Low / Medium / High / Very high steering gain. |
| Jump surge threshold | +8 to +18 RPM above the learned baseline (default +12). |
| Recenter head now | Re-learns the neutral head position. |
| Ditch timing guide | Draws the takeoff window on the trail. |
| World seed | Random each ride, or a fixed seed for reproducible layouts (restarts). |
| Simulated cadence | Developer-only fake RPM with an on-screen `SIMULATED SURGE` button. The HUD is labeled `SIMULATED`, and simulated input never reaches the bike. |
| Restart ride now | Starts a new ride. |
| Diagnostics overlay | Shared with the other games. Shows face age and x, steering target vs rider x, trail center and lateral error, RPM age/baseline/threshold/boost, jump state and time to the next ditch, last crash reason, frame/update/draw timings, sprite count, memory and world sizes. |

TRAIL RIDE has not yet been qualified on the physical console. Use the
diagnostics overlay (frame, update and draw p50/p90) with face tracking
active to confirm it holds about 30 FPS on the Atom Z3735G.

## Build and test

JDK **21**, Android SDK Platform **34**, NDK **26.1.10909125**, CMake **3.22.1**.
A local Android SDK is required (`native/local.properties` `sdk.dir=...`).

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot"
cd native
.\gradlew.bat :equipment-protocol:test :bridge-app:testReleaseUnitTest :equipment-usb-probe:testDebugUnitTest :arcade:testDebugUnitTest
.\gradlew.bat :bridge-app:assembleRelease -PbridgeIdentity=production
```

Production assemble refuses `-PunlockQualification=auth` or `lockout`. Staging:

```powershell
.\gradlew.bat :bridge-app:assembleDebug
```

produces `com.fitbaus.bikebridge.native` (WarmState when unlockQualification=off:
skips VerifySecurity; not a reliable cold-controller control path).

CI runs the same Native unit tests. It does not sign, deploy, or talk to a bike.

### Operator isolation (not in-app)

```text
adb -s <console>:5555 shell "am force-stop com.ifit.standalone; am force-stop com.ifit.eru"
adb -s <console>:5555 shell monkey -p com.fitbaus.bikebridge -c android.intent.category.LAUNCHER 1
```

Install with `adb install -r` so pairing data is preserved. Signing must match
the already-installed production certificate. Keystores are not in Git.

## License

FitBaus-owned source in this component is intended to be distributed under the
parent FitBaus Trainer repository’s **AGPL-3.0-only** license. STRIDE
Apache-2.0 attribution is in `native/equipment-protocol/NOTICE`. Do not commit
proprietary vendor runtimes or signing keys.
