# Reverse-engineering notes

Findings from read-only inspection of decompiled 2017 iFIT/Shire/Wolf trees and extracted assemblies. This is our understanding of interfaces and behavior. Decompiled source is not copied here.

Reference material was studied locally outside this repository (decompiled trees and extracted APK assemblies). Do not commit those trees. Typical local placeholders:

- `<local>/shire-src`, `<local>/shire-android-src`
- `<local>/wolf-core-src`, `<local>/wolf-android-src`
- `<local>/standalone-extracted/assemblies` (Wolf)
- `<local>/eru-extracted/assemblies` (ERU compile-time BCL refs only)

Populate gitignored `third_party/` copies via `scripts/copy-shire-runtime.ps1 -Source …`.

## Assembly identity

| Assembly | Source | Version | Target |
| --- | --- | --- | --- |
| Shire.Core | standalone | 1.0.6451.31616 | `mscorlib 2.0.5.0` (Xamarin), MSIL |
| Shire.Android | standalone | 0.0.0.0, 336 KB | MonoAndroid, USB types present (likely linker-trimmed UI) |
| Shire.Core | ERU | 1.0.6583.27999 | Decompiled `Shire.Core.csproj` says PCL Profile 259 |
| Shire.Android | ERU | 0.0.0.0, 1.6 MB | Decompiled csproj says MonoAndroid v7.0 |
| Mono.Android | standalone | 0.0.0.0, ~2 MB, pkt `84e04ff9cfb79065` | Linker-trimmed runtime bindings; not a compile-time ref |
| Mono.Android | ERU | 0.0.0.0, ~24 MB | Full Xamarin Android bindings; used only as compile-check BCL |
| mscorlib | standalone | 2.0.5.0, pkt `7cec85d7bea7798e` | Xamarin/Silverlight profile |
| MvvmCross.Platform | standalone | 4.0.0.0 | IoC (`MvxSimpleIoCContainer`) |
| System.Reactive.* | standalone | 2.2.5.0 | LINQ-to-Rx used throughout FitPro |

POC decision: reuse **standalone/Wolf** binaries because that is the process that already talks to this bike.

Native libs in `standalone.apk`: `lib/x86/libmonodroid.so`, `libmonosgen-2.0.so` (plus sqlite/mapbox). x86 32-bit is real.

## USB bootstrap (Wolf)

`Wolf.Android.PlatformWolfAppSetup.CheckBuiltIn` (built-in USB consoles):

```text
CustomUsbDevice device = new CustomUsbDevice();
settings.ConnectAndRememberUsbMachine(device, FitProUsbConsoleFactory.Create, tcs);
tcs.Task.Wait();
```

`LocalSettings.ConnectAndRememberUsbMachine` is orchestration only:

1. Subscribe `device.WhenConnectionStateChanged` where connected, Take(1)
2. `console = createConsoleFunc(device)`
3. Subscribe `console.WhenConsoleInitialized` Take(1), then store console
4. `device.Connect()`

No extra Wolf-only brainboard protocol appears here.

## CustomUsbDevice

- VID 8508, default `UsbProductId.BrainBoard = 2`, bootloader = 153
- `UsbManager.OpenDevice` + `ClaimInterface(interface 0, force: true)`
- Permission action string: `com.ifit.standalone.USB_PERMISSION`
- Uses `Application.Context`
- Logs via `LogInstance.Logger` (`LogTag.Usb`)

## FitPro USB connection

`FitProUsbConsoleFactory.Create`:

```text
FitProUsbConsoleConnection(device)
FitProUsbConsoleCommunicationAdapter(connection)
new FitProConsole(connection, adapter)
```

`FitProUsbConsoleConnection`:

- endpoint 1 write, endpoint 0 read
- bulk timeout 200 ms
- read buffer 64 bytes
- `SendAsBulkTransfer: true` on the normal path

POC does not drive those endpoints itself.

## FitProConsole initialization

Constructor waits for `adapter.Connection.WhenInitialized`, then:

```text
EquipmentConsole = new EquipmentConsole(this)
ChangeManager.Bits = EquipmentConsole.BitFieldValues
await EquipmentConsole.Init()
StartKeyEnabled = false
IsInitialized = true
ConsoleInfo = new ConsoleInfo(EquipmentConsole)
LatestBasicInfo = new ConsoleBasicInfo(EquipmentConsole)
whenConsoleInitialized.OnNext(ConsoleInfo)
```

`IFitProConsole` exposes `SetResistance(double)` among other workout controls. Phase 1 must not call it.

## EquipmentConsole.Init

Verified sequence: SystemInfo, DeviceInfo(Main), VersionInfo, PrimaryDevice, Unlock/VerifySecurity, device tree, startup fields, periodic telemetry.

Periodic fields include Resistance, Rpm, Watts (and many others). Interval default 100 ms.

`SetResistance` is `SetBasicValues(null, null, resistance)` -> `BitField.Resistance` write via `ReadWriteDataCmd`. Forbidden in Phase 1.

Security hash is a local nibble mix of serial/part/model (`EquipmentUtil.CalculateSecurityHash`). Not BouncyCastle.

## Telemetry types

`IConsoleBasicInfo`: `double Watts`, `double Resistance`, `double Rpm` (backed by `IBitFieldValues`; Watts/Rpm are ints on the bitfield type).

`IConsoleInfo`: `Name`, `MachineType` (`ConsoleType`, bike from `Device.FitnessBike` or `SpinBike`), `CanSetResistance`, `MaxResistanceLevel`, model/part/serial.

`WhenMetricChanged` uses `MetricChange.MetricType.{Resistance,Rpm,Watts,...}`.

## Logger contract

`LogInstance.Logger` throws `ArgumentException("Please first initialize the logger singleton...")` if unset.

Wolf `CommonWolfAppSetup.SetupLogger`:

```text
FileLogger.Create(path, ISchedulerService)
ConsoleAndFileLogger.Create(ConsoleLogger.Create(writeLineAction), fileLogger)
EnableAllLogTags(); DisableLogTag(LogTag.Ble);
LogInstance.Logger = consoleAndFileLogger
```

Called from `Wolf.Android.Setup.InitializeIoC` after `base.InitializeIoC()`.

`ConsoleLogger.Create(Action<string>)` is sufficient for the POC. Tags default to none; they must be enabled or nothing is emitted.

`BaseLogger.EnableAllLogTags` uses MoreLinq.

## Other global init actually required by the hardware path

| Dependency | Why |
| --- | --- |
| `LogInstance.Logger` | USB + FitPro log on almost every step |
| `Mvx.Resolve<IFatalityService>()` | `FitProCommunicationAdaper` ctor, `QueueManager` ctor |
| `System.Reactive.PlatformServices` | `Delay` / `Timer` inside FitProConsole and EquipmentConsole |
| `Application.Context` | `CustomUsbDevice` field initializer |

Not required for this path: Akavache, iFIT HTTP API, BLE scanner, maps, Facebook/Google login, HockeyApp. Wolf still builds a huge graph around USB; the USB call itself does not.

`MvxSimpleIoCContainer.Initialize()` exists as a public static on MvvmCross 4. `Mvx.RegisterSingleton<T>(T)` exists.

## Shire.Core reference fan-out

The reconstructed `Shire.Core.csproj` lists the full Wolf-era PCL dependency set (MvvmCross, Rx, Splat, Akavache, JSON, MathNet, BouncyCastle, Polly, Refit, AWS, ...). That is the *assembly* graph, not the hardware call graph.

Do not recreate the entire Wolf project. For the first APK, embed original DLLs and let Mono lazy-load. If a `FileNotFoundException` names another assembly on device, add that DLL - do not rewrite it.

## Stop conditions encountered

1. **Classic Xamarin packaging is blocked on this PC** until archived Xamarin.Android 13.2.2, JDK 11, and Android SDK Platform 24 are installed. C# can still be type-checked against the extracted refs. See `docs/TOOLCHAIN.md`.
2. Mixing ERU and standalone Shire versions would be an unforced error; do not do it.
3. Raw USB bulk writes were not required and were not implemented.

## Uncertainties

- Whether linker-trimmed standalone `Shire.Android.dll` is missing a USB helper we do not currently call (USB types we need are present).
- Whether first device run will demand extra Shire.Core referenced DLLs (Akavache/JSON/etc.) because some static ctor touches them.
- Whether `IdleModeLockout` after Init changes any rider-visible behavior vs Wolf.
- Exact Wolf launcher activity class name on device (use `monkey -p com.ifit.standalone`).
- Whether a physical resistance key works with Wolf stopped.
