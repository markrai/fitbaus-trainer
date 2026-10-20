# Phase 1 / Phase 2 POC test plan

Host-side tests are current. Hardware sections below mix **proven Phase 1**
procedures with a **historical Phase 2 GET-only LAN checklist**.

The codebase now exposes `POST /api/v1/resistance` (and HR/brightness). Do **not**
treat the older “confirm POST rejected / no resistance write” steps as the
present product contract. Physical resistance-control acceptance remains an
operator-owned session outside this publication cleanup.

## Host / unit tests (no hardware)

From the repo root:

```powershell
dotnet test tests\Fitbaus.BikeBridge.Core.Tests\Fitbaus.BikeBridge.Core.Tests.csproj
```

These cover our code only:

- USB/Shire status mapping (`USB device not found`, permission, connected, init, failed, streaming, disconnected)
- bootloader PID refused
- telemetry store semantics (unknown vs observed zero, independent timestamps, stable values stay current, disconnect clear, reconnect does not resurrect, snapshot isolation, concurrent updates)
- console UI formatting (`-` vs `0`; no stale suffix on stable values)
- HTTP contract (`GET /health`, `GET /api/v1/telemetry`, JSON `current`, 405 on mutation methods)
- UI/logcat throttle (UI 200 ms, log 1 s)

They do not mock the FitPro protocol.

C# compile-check against original Shire/MonoAndroid references:

```powershell
powershell -File scripts\compile-android-against-shire.ps1
```

That produces `artifacts\compile-check\Fitbaus.BikeBridge.Android.dll`. It is **not** an APK.

## APK / ABI checks (before the bike)

Do not install on the console until archived Xamarin.Android 13.2.2, JDK 11, and Android SDK Platform 24 are installed and an x86 APK exists. See `docs/TOOLCHAIN.md`.

```powershell
powershell -File scripts\verify-xamarin-toolchain.ps1
# then msbuild the Android project
powershell -File scripts\inspect-apk.ps1 -Apk path\to\com.fitbaus.bikebridge.apk
```

After a successful Xamarin build, confirm:

1. `lib/x86/libmonodroid.so` and `lib/x86/libmonosgen-2.0.so` are present (not arm64-only).
2. Manifest has `minSdkVersion=22`, `targetSdkVersion=22`, `package=com.fitbaus.bikebridge`.
3. Required assemblies are packed: `Shire.Core`, `Shire.Android`, `MvvmCross.Platform`, `System.Reactive.*`, `MoreLinq.Portable`.
4. Optional: `aapt dump badging path\to.apk`

## Hardware acceptance (physical bike) - Phase 1 (already proven)

Native Resistance, RPM, and Watts were proven on the ProForm Smart Power 10.0. The operator isolation procedure remains:

```text
adb shell "am force-stop com.ifit.standalone; am force-stop com.ifit.eru"
```

Wolf first, ERU immediately second, same device shell. Do not bake this into FitBaus.

## Phase 2 physical LAN validation (historical GET-only checklist)

**Historical scope:** written when the HTTP surface was GET-only. Keep for
telemetry freshness checks; update any control assertions before re-running
against a current build.

1. Repeat the proven paired isolation, install the APK, launch FitBaus.
2. Confirm unknown metrics show `-` until native events, then `0` when genuinely idle.
3. From a trusted LAN client, `GET http://<console>:8765/health` and `GET http://<console>:8765/api/v1/telemetry`.
4. Confirm JSON `value: null` before observation and numeric `0` after a real zero.
5. Pedal and confirm RPM/Watts in both UI and HTTP.
6. *(Historical)* Older builds rejected POST on those GET paths; current builds expose dedicated `POST /api/v1/*` control/display endpoints — do not use this step as today’s contract.
7. Force-stop FitBaus and restore Wolf as in Phase 1.

## Hardware acceptance (physical bike) - Phase 1 procedure

**Do not start this until an x86 API 22 APK can be installed.** This app must own USB; Wolf must be stopped, not uninstalled.

1. Confirm stock bike behavior is working (Wolf can see RPM/watts).
2. Stop Wolf **and** ERU in **one device shell** (Wolf first, ERU immediately second). `am force-stop` of either package alone is not enough: ERU `KeepTheWolfAlive` relaunches Wolf, and Wolf's `EruIpcService` binding relaunches ERU.

   ```text
   adb shell "am force-stop com.ifit.standalone; am force-stop com.ifit.eru"
   ```

   Confirm both processes are absent for several seconds and stock FitPro USB reads have stopped. Do not disable, uninstall, or clear data. Do not bake this into FitBaus.

3. Install (if needed) and launch FitBaus Bike Bridge:

   ```text
   adb install -r path\to\com.fitbaus.bikebridge.apk
   adb shell monkey -p com.fitbaus.bikebridge -c android.intent.category.LAUNCHER 1
   ```

4. USB brainboard is detected (UI USB row / logcat `vid=8508 pid=2`).
5. Permission/claim succeeds (`USB connected`, Shire USB logs).
6. Shire initialization completes (`Shire initialized` / log `console initialization success`).
7. Detected machine information is displayed and logged (`type`, `canSetResistance`, `maxResistanceLevel`).
8. Stationary bike shows approximately RPM = 0, Watts = 0. Resistance shows the current native level.
9. Pedal slowly.
10. RPM rises.
11. Watts rises.
12. Stop pedaling.
13. RPM / Watts return toward zero (or the bike's idle behavior).
14. Observe current Resistance from telemetry (requested vs observed are different).
15. If a physical/manual stock hardware control can change resistance **without Wolf**, change it manually and confirm telemetry follows. Programmatic `POST /api/v1/resistance` is a separate, operator-owned control acceptance — not part of this Phase 1 checklist.
16. Terminate FitBaus Bike Bridge:

    ```text
    adb shell am force-stop com.fitbaus.bikebridge
    ```

17. Restart stock Wolf:

    ```text
    adb shell monkey -p com.ifit.standalone -c android.intent.category.LAUNCHER 1
    ```

18. Confirm stock iFIT reconnects to the bike.

## Logcat during the bike test

```text
adb logcat -c
adb logcat -s FITBAUS_BRIDGE:I *:S
```

Expect at least:

- application startup
- Shire logger initialization
- USB discovery with VID/PID
- permission state
- USB connection
- FitProConsole creation
- console initialization start/success
- machine / `canSetResistance` / `maxResistanceLevel`
- throttled telemetry lines
- disconnect on exit

USB packet dumps should not appear by default.

## Rollback

If anything looks wrong, force-stop FitBaus and relaunch Wolf (steps 16-18). Do not uninstall `com.ifit.standalone` or `com.ifit.eru`.
