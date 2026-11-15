# Capacitor native development

FitBaus Trainer supports both a browser/PWA build and native Android/iOS applications through Capacitor.

- `npm run build` compiles TypeScript into `dist/` for the hosted PWA.
- `npm run build:native` bundles the application with esbuild into generated `www/` assets for Capacitor.

The native application ID is `com.markrai.fitbaus.trainer`.

Browser and native WebView storage are independent. Each uses IndexedDB, localStorage, and sessionStorage, but data is not automatically transferred between installations. Export any workout history or personalization data from a legacy installation before removing it. No automatic legacy migration is provided.

## Requirements

| Platform | Requirements |
| --- | --- |
| Common | Node.js 22 or newer |
| Android | Android Studio 2025.2.1+, minimum API 24, current target API 36 |
| iOS | macOS, Xcode 26+, Swift Package Manager |

Android 17 (API 37) introduces the `ACCESS_LOCAL_NETWORK` runtime permission for applications targeting API 37+ that access LAN hosts. Revisit this requirement when FitBaus raises its target SDK.

Bluetooth functionality must be tested on physical devices. The iOS Simulator does not support BLE.

## Build commands

Run from the repository root.

| Command | Purpose |
| --- | --- |
| `npm run check` | TypeScript type checking |
| `npm run build` | Build the browser/PWA application |
| `npm run build:native` | Generate native web assets |
| `npm run cap:sync` | Synchronize both native platforms |
| `npm run cap:sync:android` | Synchronize Android |
| `npm run cap:sync:ios` | Synchronize iOS |
| `npm run android` | Synchronize and open Android Studio |
| `npm run ios` | Synchronize and open Xcode (macOS) |

The iOS synchronization scripts also normalize Swift Package Manager configuration. CocoaPods is not required.

To build a debug Android APK on Windows after synchronization:

```powershell
android\gradlew.bat -p android assembleDebug
```

## Runtime differences

Both applications share the same workout logic, but platform services differ.

| Capability | Browser/PWA | Native Android/iOS |
| --- | --- | --- |
| Heart-rate monitoring | Web Bluetooth | Capacitor BLE |
| Spoken instructions | Browser speech synthesis | Native text-to-speech |
| Screen wake lock | Screen Wake Lock API | Capacitor Keep Awake |
| HTTP requests | Browser `fetch` | CapacitorHttp |
| Offline application support | Service worker | Packaged application assets |
| Data storage | Browser-local | Native WebView-local |

Native applications do not register the PWA service worker or display browser installation prompts.

### Network and security boundaries

**SISU synchronization**

Native requests to SISU `/health` and `/workout/ingest` use `CapacitorHttp` and require HTTPS. Application-level validation rejects insecure `http://` SISU endpoints.

**FitBaus Bike Bridge**

The optional equipment bridge communicates over trusted-LAN HTTP, typically `http://<console>:8765`.

Native requests use `CapacitorHttp` for status, telemetry, resistance control, heart-rate forwarding, and console brightness.

The hosted PWA cannot currently access the bridge directly because the bridge does not return CORS headers. Native HTTP avoids this browser restriction.

Platform networking configuration:

- **Android:** Network Security Config permits application-wide cleartext HTTP for LAN communication. This permission is not restricted to the bike's address.
- **iOS:** `NSAllowsLocalNetworking` permits local-network communication.

Bridge endpoints must remain on a trusted local network. Do not expose equipment-control endpoints to the public Internet.

For equipment-specific protocols and pairing requirements, see the [ProForm Smart Power 10.0 Bridge documentation](../equipment-bridges/proform-smart-power-10/README.md).

## Physical-device validation

Validate the following on supported physical devices before release:

- **Application lifecycle:** Packaged assets load correctly, without PWA installation prompts or service-worker registration.
- **Bluetooth:** Chest-strap discovery, connection, live BPM, supported battery reporting, disconnection, and reconnection work.
- **Workout lifecycle:** Keep Awake activates during workouts and releases on pause, completion, or cancellation. Spoken instructions follow the existing workout lifecycle.
- **SISU:** HTTPS health checks and completed-workout uploads succeed using the expected payload contract.
- **Bike Bridge:** Settings → Equipment accepts the bridge address and pairing code. Telemetry is readable, authorized structured workouts send non-overlapping resistance commands, chest-strap BPM reaches the console for display, and brightness control works.

Bridge validation requires compatible hardware. BLE and equipment integration cannot be fully qualified through emulators.

## Release preparation

Native marketing version and Android `versionName` come from repository-root
`version.js` (currently **1.0.0**, numeric code **10000**). `npm run cap:sync`
does not by itself bump store versions; Gradle and `scripts/sync-version.cjs`
read the canonical file. See [VERSIONING.md](../VERSIONING.md).

Trainer Android **release** APKs from Gradle are unsigned unless you add a
signing config. Unsigned APKs are not normally installable. `adb install -r`
requires certificate continuity with any already-installed build.

iOS distribution is not produced in CI. Xcode Automatic signing is local-only
until a macOS runner and Apple credentials exist.

Native projects currently use Capacitor's generated placeholder store artwork. Replace these with final FitBaus-branded icons and splash assets before Play Store or App Store distribution.