# Architecture

## Purpose

FitBaus Bike Bridge is the equipment bridge for the **ProForm Smart Power 10.0**
console (Android 5.1.1 / API 22 / x86). Phase 1 proved USB claim, Shire init,
and live Resistance / RPM / Watts on hardware. The application snapshot and LAN
HTTP contract remain; the current tree also exposes bounded absolute resistance
control, display-only HR ingest, and console-window brightness (see Control
policy and README).

Early “Phase 2 read-only / GET-only” wording is historical and does not describe
the present HTTP surface.

## Toolchain selected - and why

| Layer | Choice | Why |
| --- | --- | --- |
| Host tests | .NET 9 + xUnit | Installed (`net9.0` / `net10.0` SDKs). No Android needed. |
| Device app | Classic **Xamarin.Android** (MonoAndroid v7.0), minSdk 22, ABI **x86 only** | Original Shire binaries target `mscorlib 2.0.5.0` (Xamarin profile) + `Mono.Android`. |
| Shire reuse | Original Wolf/standalone `Shire.Core.dll` + `Shire.Android.dll` | Lowest-risk way to get `EquipmentConsole.Init()` and native telemetry. |

Rejected:

- **`net8+/net10-android` (MAUI / .NET for Android):** 32-bit `android-x86` was dropped; Xamarin `mscorlib 2.0.5.0` assemblies will not load.
- **Java/Kotlin reimplementation of FitPro:** stop-condition (clean-room protocol port).
- **Hand-packing a Mono APK from `standalone.apk`:** would require forging ACWs and `typemap.*`; too fragile vs archived Xamarin.Android 13.2.2.

## Toolchain (classic Xamarin.Android)

Archived **Xamarin.Android 13.2.2**, **JDK 11**, and Android SDK **Platform 24** are required to package the x86 APK. Details: [TOOLCHAIN.md](TOOLCHAIN.md). Debug builds keep `AndroidLinkMode=Full` plus `LinkerPleaseInclude.xml` (MvvmCross IoC, Rx PlatformServices, Shire BitFieldValues 88/88). Do not switch to LinkMode=None/SdkOnly; that reintroduces XA0121 / GPS/Support javac failures.

Do **not** use Visual Studio Installer "Mobile development with .NET". Do not migrate Shire to modern .NET Android. Do not rewrite the USB protocol.

## Process split

```
Fitbaus.BikeBridge.Core     net9.0 (also compiled as C# 6 linked sources into the Android app)
        ^
        | project reference
Fitbaus.BikeBridge.Core.Tests

Fitbaus.BikeBridge.Android  MonoAndroid v7.0
        | links Core .cs files (cannot reference net9.0)
        | references Wolf Shire + Rx + MvvmCross.Platform + MoreLinq
```

Core is compiled twice: once as net9.0 for tests, once as linked sources inside the Xamarin app so types live on `mscorlib 2.0.5.0`.

## USB / Shire bootstrap (implemented)

Matches Wolf `LocalSettings.ConnectAndRememberUsbMachine` without Wolf settings/cache:

1. Initialize `LogInstance.Logger` with `ConsoleLogger.Create` -> logcat tag `FITBAUS_BRIDGE`.
2. Load `System.Reactive.PlatformServices` (needed for `Observable.Timer` / `.Delay` inside Shire).
3. `MvxSimpleIoCContainer.Initialize()` and `Mvx.RegisterSingleton<IFatalityService>(new FatalityService())`.
   `FitProCommunicationAdaper` and `QueueManager` both `Mvx.Resolve<IFatalityService>()` in their constructors.
4. Enumerate `UsbManager` for VID 8508 / PID 2 (diagnostic only). PID 153 is logged and refused.
5. `CustomUsbDevice device = new CustomUsbDevice();`
6. Subscribe `device.WhenConnectionStateChanged` **before** `device.Connect()`.
7. On connected: `IFitProConsole console = FitProUsbConsoleFactory.Create(device);`
8. Subscribe `console.WhenConsoleInitialized` and `console.WhenMetricChanged`.
9. Shire constructs `FitProUsbConsoleConnection` -> `FitProUsbConsoleCommunicationAdapter` -> `FitProConsole`.
10. `FitProConsole` then `new EquipmentConsole(this)` and `await Init()`.

`FitProUsbConsoleFactory.Create` is the only console factory used. Application code does not open bulk endpoints itself.

## Initialization Shire already owns

`EquipmentConsole.Init()`:

- `SystemInfoCmd`
- `DeviceInfoCmd(Device.Main)`
- `VersionInfoCmd`
- `QueueManager.PrimaryDevice`
- `Unlock()` / `VerifySecurityCmd`
- device tree (`SupportedDevices` / `SupportedCommands`)
- startup field reads (`Defaults.StartupFields`, includes `MaxResistanceLevel`)
- `StartPeriodicData()` every 100 ms over `Defaults.PeriodicFields` (includes Resistance, Rpm, Watts)

After Init, `FitProConsole` sets `StartKeyEnabled = false`, which enqueues `IdleModeLockout`. That is stock init, not a resistance write.

## Telemetry path

```text
ShireRuntimeHost  (USB + FitProConsole + subscriptions)
        |
        v
BikeTelemetryStore  (thread-safe, Core)
        |
        +--> MainActivity display
        +--> TelemetryHttpServer  (TcpListener)
```

- `WhenMetricChanged` for `Resistance | Rpm | Watts` observes **that metric only** from `LatestBasicInfo`. Sibling timestamps are not updated.
- Console init does **not** copy `LatestBasicInfo` into the snapshot. CLR numeric defaults are not treated as observations. That is the Phase 1 startup `Resistance=0` bug.
- Store updates at native event frequency. UI/logcat stay throttled (200 ms / 1 s). HTTP returns the latest snapshot.
- Watts are native machine watts. No smoothing, averaging, calibration, or inference.
- `CanSetResistance` / `MaxResistanceLevel` are machine metadata, not telemetry, and do not gate reads.

### Current vs unobserved

`int?` (null = not yet observed). Observed `0` is `0`. UI: `-` vs `0`. Disconnect clears current metrics so old values are not presented as live.

`observedAt` is the last `WhenMetricChanged` observation/change event for that field during this USB session. It is not a 100 ms QueueManager heartbeat. Updating RPM does not update Resistance/Watts timestamps.

A metric is **current** when `connected && initialized` and a genuine observation exists. A stable Resistance of `5` remains current for minutes if the session stays up. There is no elapsed-time stale timeout based on `WhenMetricChanged`. Phase 2 does not expose a transport heartbeat; `connected` / `initialized` are lifecycle flags. A future version may add `lastMachineResponseAt` / `transportHealthy` only after a reliable successful-response signal is identified.

## LAN HTTP service

`System.Net.Sockets.TcpListener` in Core. Compatible with MonoAndroid v7.0 / API 22 (`System.dll`). No ASP.NET Core.

- Bind: `0.0.0.0:8765` (`TelemetryListenOptions`)
- Owned by `BridgeApplication` / `BridgeRuntime` (one listener per process, not per Activity)
- `GET /health`, `GET /api/v1/telemetry`, `GET /api/v1/status`
- `POST /api/v1/resistance`, `POST /api/v1/heartrate`, `POST /api/v1/brightness`
- No CORS headers (simpler default)
- No authentication (**trusted LAN only**; do not expose to the public Internet)
- `android.permission.INTERNET` is required to bind
- Port-in-use: log and continue; USB telemetry still works
- Streaming (SSE/WebSocket) is a possible later follow-up, not implemented

## Control policy

`ShireRuntimeHost` keeps `IFitProConsole` private. The only FitBaus-owned equipment write is `IEquipmentConsole.SetResistance` for an application-validated integer 1-15, reached only through `POST /api/v1/resistance` when the FitPro/equipment consoles are initialized. Requested resistance is recorded separately from telemetry and is not copied into observed state — acceptance is not proof the physical bike has reached that level. `SetGrade` / `SetIncline` / `SetKph` / `SetValues`, raw USB, and bootloader types remain forbidden. See `BridgeControlPolicy.cs`. Wolf/ERU isolation remains operator-owned; the app never force-stops stock packages.

Resistance calls are serialized. Clients should wait for one request to complete before issuing the next. Ordering between genuinely simultaneous requests is unspecified. `ResistanceCommandCoordinator` serializes the LAN transaction (setter + accepted-state). `ShireRuntimeHost._setterGate` defensively prevents concurrent hardware setter entry.

## Minimum runtime DLLs (hardware path)

Must ship with the Xamarin APK (plus the Xamarin BCL the toolchain embeds):

- `Shire.Core.dll`
- `Shire.Android.dll` (standalone copy still contains USB types)
- `MvvmCross.Platform.dll` (IoC only; no full MvvmCross app setup)
- `System.Reactive.Interfaces.dll`
- `System.Reactive.Core.dll`
- `System.Reactive.Linq.dll`
- `System.Reactive.PlatformServices.dll`
- `MoreLinq.Portable.dll` (`QueueManager`, `EquipmentUtil`, `BaseLogger.EnableAllLogTags`)

`Shire.Core` has many additional *assembly* references (Akavache, AWS, JSON, ...). Mono loads those lazily. If a missing assembly is touched at runtime, that is a follow-up. Hardware-path source does not call those types.

Use **standalone** Shire, not ERU. Versions differ.

## Logging

Wolf uses `ConsoleAndFileLogger` (`ConsoleLogger` + `FileLogger`). `FileLogger.Create` needs `ISchedulerService` from Mvx - unnecessary for this POC.

Smallest valid init:

```csharp
ConsoleLogger logger = ConsoleLogger.Create(line => Android.Util.Log.Info("FITBAUS_BRIDGE", line));
logger.EnableLogTag(LogTag.Usb);
logger.EnableLogTag(LogTag.Startup);
logger.EnableLogTag(LogTag.Connection);
logger.EnableLogTag(LogTag.Workout);
logger.EnableLogTag(LogTag.Error);
logger.EnableLogTag(LogTag.Fatal);
LogInstance.Logger = logger;
```

`LogInstance.Logger` getters throw if unset. `FitPro` tag is left disabled to avoid KPH/time spam from `BitFieldChangeManager`; our code logs throttled telemetry instead.

## USB permission note

`CustomUsbDevice` hardcodes intent action `com.ifit.standalone.USB_PERMISSION`. Reusing the binary means we cannot change that string. It does not need to match our package name.

## What is not in this process

No MvvmCross presenter, Akavache, iFIT API, BLE, maps, HockeyApp, or Wolf `LocalSettings` persistence.
