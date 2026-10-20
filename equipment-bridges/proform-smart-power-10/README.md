# FitBaus equipment bridge for ProForm Smart Power 10.0

Trusted-LAN Android bridge for **one** machine: the **ProForm Smart Power 10.0**
console. It claims the bike USB interface while stock Wolf/iFIT is stopped,
exposes native Resistance / RPM / Watts telemetry, and serves a small HTTP API
on the local network.

This is an **equipment bridge**, not a stand-alone flagship product. FitBaus
Trainer is the product. This tree is intended to live under:

```text
equipment-bridges/proform-smart-power-10/
```

Source namespaces such as `Fitbaus.BikeBridge.*` remain bike-specific
implementation names; the generic organization is the folder layout, not a
forced API rename.

## Target hardware (exact)

| Item | Value |
| --- | --- |
| Console | ProForm Smart Power 10.0 only |
| Android | 5.1.1 / API 22 |
| ABI | x86 (`byt_t_crv2`) |
| Stock packages | `com.ifit.standalone` (Wolf), `com.ifit.eru`, `com.ifit.launcher` |
| Brainboard USB | VID `8508`, normal PID `2`, bootloader PID `153`, interface `0` |

**Not claimed:** generic ProForm, generic exercise bikes, other iFIT equipment,
or modern 64-bit Android consoles.

## USB ownership

Do not run this bridge and Wolf at the same time. They cannot share the USB
interface.

- **Stock mode:** `com.ifit.standalone` owns USB.
- **FitBaus mode:** stop Wolf (and ERU), then launch this app. Do not uninstall Wolf.

This app does **not** kill, disable, or uninstall stock packages. Isolation is
an operator/adb step.

## Current capabilities (source of truth)

Implementation + Core tests define behavior. Historical “Phase 2 read-only”
prose is obsolete.

### Trusted-LAN HTTP (`0.0.0.0:8765`)

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/health` | Listener health + connection flags |
| `GET` | `/api/v1/status` | Bridge / machine status |
| `GET` | `/api/v1/telemetry` | Observed resistance / RPM / watts |
| `POST` | `/api/v1/resistance` | Absolute integer resistance request |
| `POST` | `/api/v1/heartrate` | Display-only HR ingest (does not control the bike) |
| `POST` | `/api/v1/brightness` | Console **window** brightness (does not control the bike) |

There is **no** authentication and **no** CORS. Bind is on all interfaces for
LAN reachability. **Trusted local network only. Do not expose to the public
Internet.** Any client that can reach the console can call these endpoints.
Resistance control moves physical machine load.

The surface does **not** expose arbitrary Shire, USB, incline, calibration,
firmware, bootloader, relative ± resistance, ramping, or workout-control APIs.
See `BridgeControlPolicy.cs`.

### Resistance control

- Accepted body: absolute integer **1–15** (`ResistanceLimits`).
- Validated requests go through `ResistanceCommandCoordinator` then
  `IEquipmentConsole.SetResistance(double)` only.
- Guards: FitPro console must be present and initialized; equipment console
  must be initialized. Requests are serialized; clients should wait for one
  acceptance before issuing another.
- Shire metadata `canSetResistance` / `maxResistanceLevel` are reported but are
  **not** the application acceptance window.

**Requested vs observed:** accepting a POST records a *requested* level. It is
**not** proof the physical bike has reached that resistance. Observed
resistance comes only from native `WhenMetricChanged` telemetry and is never
overwritten by the request path.

### Heart rate and brightness

- HR: display ingest only (BPM window in `HeartRateLimits`); never initializes
  USB or changes resistance/telemetry.
- Brightness: Activity window percent 0–100 (`BrightnessLimits`); never bike
  control.

## Security boundary

| Fact | |
| --- | --- |
| Auth | None |
| Intended network | Trusted LAN only |
| Public Internet | **Must not** be exposed |
| Resistance POST | Physical-machine action |

Do not assume cryptographic protection that the code does not implement.

## Historical notes (not current contract)

**Phase 1** physically proved USB claim, Shire init, and live native Resistance /
RPM / Watts on this ProForm while Wolf was stopped. Early work did not yet
implement FitBaus resistance writes.

**Phase 2** originally added the application telemetry snapshot and GET-only
HTTP. That read-only description is **historical**. The tree now also includes
bounded resistance, HR display ingest, and brightness endpoints as above.

Keep [docs/POC-TEST-PLAN.md](docs/POC-TEST-PLAN.md) for hardware procedures, but
treat its older “no resistance write / GET-only” steps as historical Phase 2
LAN checks unless updated for control endpoints.

## Third-party runtime (not in Git)

Build and device packaging reuse original Wolf/standalone Shire-era assemblies.
Those binaries are **not** committed. FitBaus does not redistribute them; they
have their own licensing/rights. This repository’s FitBaus-owned source is
intended to be distributed under the parent FitBaus Trainer **AGPL-3.0-only**
license; that license **does not** cover proprietary runtime components.

Populate gitignored dirs with your own compatible assemblies:

```powershell
powershell -File scripts\copy-shire-runtime.ps1 -Source <path-to-wolf-standalone-assemblies>
```

See [third_party/README.md](third_party/README.md). Public CI cannot produce the
device APK without separately supplied compatible runtime inputs.

## Repository layout

- `src/Fitbaus.BikeBridge.Core` — host-testable logic (no Shire types on the wire)
- `src/Fitbaus.BikeBridge.Android` — Xamarin.Android app + Shire bootstrap
- `tests/Fitbaus.BikeBridge.Core.Tests` — unit tests
- `docs/` — architecture, toolchain, test plan, reverse-engineering notes
- `scripts/` — toolchain verify, Shire copy/compile-check, APK inspect

## Build

Host tests (no bike, no proprietary APK packaging):

```powershell
dotnet test tests\Fitbaus.BikeBridge.Core.Tests\Fitbaus.BikeBridge.Core.Tests.csproj
```

Optional C# compile-check against local Shire/MonoAndroid refs (not an APK):

```powershell
# Requires ShireRuntimeDir / XamarinRefDir or repo third_party after copy-shire-runtime
powershell -File scripts\compile-android-against-shire.ps1
```

Classic Xamarin.Android APK: see [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md)
(Xamarin.Android 13.2.2, JDK 11, Android SDK Platform 24, x86 ABI). Do not use
the VS “Mobile development with .NET” workload or modern `net*-android` for
this stack.

Deploy helper (requires an explicit device):

```text
deploy-bike.bat path\to\signed.apk host:5555
```

Or set `BIKE_ADB` / `ADB`. There is no default private console address.

## Operator isolation (not in-app)

```text
adb shell "am force-stop com.ifit.standalone; am force-stop com.ifit.eru"
adb shell monkey -p com.fitbaus.bikebridge -c android.intent.category.LAUNCHER 1
```

Restore Wolf after stopping the bridge. Details: [docs/POC-TEST-PLAN.md](docs/POC-TEST-PLAN.md).

## License

FitBaus-owned source in this component is intended to be distributed under the
parent FitBaus Trainer repository’s **AGPL-3.0-only** license. Third-party
runtime components are not included and are not covered by that license.
