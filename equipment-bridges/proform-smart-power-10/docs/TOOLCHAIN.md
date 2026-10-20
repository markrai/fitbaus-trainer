# Toolchain (classic Xamarin.Android)

Xamarin support ended **May 1, 2024**. Do **not** expect Visual Studio Installer in 2026 to offer a "Mobile development with .NET / Xamarin.Android" workload. Install the archived classic tooling from the official `dotnet/android` previous-releases list.

Immediate blocker until the steps below succeed:

> Install archived Xamarin.Android 13.2.2 + JDK 11 + Android SDK Platform 24, then prove an x86 packaged APK.

Do not migrate this app to `net*-android`. Do not rewrite the FitPro protocol.

## Why these three pieces

| Piece | Why |
| --- | --- |
| **Xamarin.Android 13.2.2 (d17-8)** | Last listed commercial Windows/VS2022 classic installer. Produces ACWs, `libmonodroid.so`, and an x86 APK that can load `mscorlib 2.0.5.0` Shire binaries. |
| **JDK 11** | Xamarin.Android 12+ moved to JDK 11. This machine currently has JDK 25 (`JAVA_HOME`) and Android Studio JBR 21; neither is the safe final-Xamarin-era choice. |
| **Android SDK Platform 24** | This project sets `<TargetFrameworkVersion>v7.0</TargetFrameworkVersion>`, which means **compile against Android 7.0 / API 24**. `minSdkVersion=22` only says the APK may *run* on the API 22 console. Xamarin requires the SDK platform that matches the Target Framework. Platforms 34/35/36 already present here do **not** satisfy v7.0. |

`minSdkVersion=22` / `targetSdkVersion=22` stay in `Properties/AndroidManifest.xml`. Do not confuse those with the compile-time Target Framework.

If 13.2.2 does not install a MonoAndroid **v7.0** targeting pack, raise `TargetFrameworkVersion` to whatever 13.2.2 actually ships (often v13.0) **without** changing minSdk 22. Prefer keeping v7.0 because recovered `Shire.Android` targeted MonoAndroid v7.0.

## Install (operator; not automated)

1. Keep Visual Studio 2022 Community (already installed: 17.14.23).
2. Download **Commercial Xamarin.Android 13.2.2 (d17-8) for Windows+Visual Studio 2022**:
   - Index: https://github.com/dotnet/android/blob/main/Documentation/previous-releases.md
   - Installer: https://aka.ms/xamarin-android-commercial-d17-8-windows
3. Install **JDK 11** (Temurin 11 LTS is fine). Point the Xamarin/JDK setting at it. Do not use JDK 25 for this project.
4. Install Android SDK **Platform 24** (`android-24`) into `%LOCALAPPDATA%\Android\Sdk` (sdkmanager or SDK Manager). Do not uninstall platforms 34/35/36; they are unused by this classic project as written.

## Verify before building the APK

```powershell
powershell -File scripts\verify-xamarin-toolchain.ps1
```

That script must report all of:

- `Xamarin.Android.CSharp.targets`
- MonoAndroid reference assemblies including `v7.0` (or document the installed TFMs if v7.0 is absent)
- an x86 Xamarin runtime/toolchain (`libmonosgen-2.0.so` / x86 NDK or XA x86 support)
- `platforms\android-24\android.jar`
- `java -version` is 11.x when using the JDK configured for Xamarin

Then re-run the host compile-check (does not need XA, but confirms Shire refs still type-check):

```powershell
powershell -File scripts\compile-android-against-shire.ps1
dotnet test tests\Fitbaus.BikeBridge.Core.Tests\Fitbaus.BikeBridge.Core.Tests.csproj
```

## Build and inspect the APK (before the bike)

From a Developer Command Prompt / VS MSBuild, with JDK 11 and Platform 24:

```text
msbuild src\Fitbaus.BikeBridge.Android\Fitbaus.BikeBridge.Android.csproj /p:Configuration=Debug /p:AndroidSupportedAbis=x86 /p:JavaSdkDirectory="C:\path\to\jdk-11"
```

Expected APK (name may vary):

```text
src\Fitbaus.BikeBridge.Android\bin\Debug\com.fitbaus.bikebridge.apk
```

Inspect before install:

```powershell
powershell -File scripts\inspect-apk.ps1 -Apk path\to\com.fitbaus.bikebridge.apk
```

Required contents:

- `lib/x86/libmonodroid.so`
- `lib/x86/libmonosgen-2.0.so`
- manifest `minSdkVersion=22`, `targetSdkVersion=22`, `package=com.fitbaus.bikebridge`
- assemblies: `Shire.Core`, `Shire.Android`, `MvvmCross.Platform`, `System.Reactive.*`, `MoreLinq.Portable`

Only after that inspection passes should hardware procedures in `docs/POC-TEST-PLAN.md` be considered (telemetry first; resistance control only in an explicit operator session).
