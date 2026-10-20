# Capacitor native development

FitBaus Trainer keeps two separate build paths. `npm run build` compiles the hosted browser/PWA application into its modular `dist/` tree. `npm run build:native` bundles the same TypeScript/DOM entry point with esbuild and stages packaged assets in generated `www/` output.

## Application identity

Native app ID / bundle ID: `com.markrai.fitbaus.trainer`. This is a separate
application from any older `com.markrai.sisutrainer` install. WebView
IndexedDB/localStorage is not shared across those identities. One-time export
from a legacy install (workout history and personalization state) is a separate
ops task — do not clear or uninstall a legacy install until that export is
verified. Runtime backward-compatibility migration is not required in this app.

## Requirements

- Node.js 22 or newer
- Android Studio 2025.2.1 or newer
- Android API 24 minimum; the generated Capacitor 8 project currently compiles and targets API 36
- Android 17 / API 37 introduces the `ACCESS_LOCAL_NETWORK` runtime permission for apps targeting API 37+ that communicate with LAN hosts. FitBaus Trainer currently targets API 36; this must be revisited when the target SDK is raised to 37.
- macOS for iOS development
- Xcode 26 or newer
- A physical iOS device for Bluetooth testing; iOS Simulator does not support BLE

The iOS project uses Swift Package Manager. CocoaPods is not required.

## Commands

```text
npm run check
npm run build
npm run build:native
npm run cap:sync
npm run cap:sync:android
npm run cap:sync:ios
npm run android
npm run ios
```

Build Android from the generated project on Windows with:

```text
android\gradlew.bat -p android assembleDebug
```

Run iOS sync and open/build commands on macOS with Xcode 26 or newer.

## Runtime boundaries

The hosted PWA continues to use Web Bluetooth, browser speech synthesis, Screen Wake Lock, browser `fetch`, and its service worker. Android and iOS use Capacitor BLE, native text-to-speech, native Keep Awake, and `CapacitorHttp` for SISU `/health` and `/workout/ingest` plus FitBaus Bike Bridge `/api/v1/status`, `/api/v1/telemetry`, and `/api/v1/resistance`. The native app intentionally does not register the PWA service worker or show PWA installation UI.

Browser/PWA storage and installed native WebView storage are separate namespaces. Both continue to use IndexedDB, localStorage, and sessionStorage; data is not migrated between installations.

Use HTTPS for SISU, especially from native builds. Native SISU traffic still rejects `http://` in application code and does not depend on browser CORS.

FitBaus Bike Bridge is trusted-LAN HTTP (typically `http://<console>:8765`). Native bike-bridge calls use `CapacitorHttp`, which bypasses WebView CORS. The bridge does not send CORS headers; hosted PWA `fetch(..., mode: "cors")` to the bridge will fail until a later CORS decision is made. Android Network Security Config permits application-wide cleartext so that LAN HTTP can connect; it is not host-restricted to the bike bridge. SISU ingest remains HTTPS-only because `requestSisu` rejects `http://`. iOS uses `NSAllowsLocalNetworking`.

Native projects currently use Capacitor's generated placeholder store artwork. Produce final Play Store and App Store icon/splash variants from the existing FitBaus Trainer branding before release.

## Device validation checklist

On a physical Android device and a physical iOS device, verify:

- The app launches from packaged assets, shows no Install tab or install prompt, and registers no service worker.
- The heart-rate chooser opens; a standards-based chest strap connects; live BPM and supported battery level update; disconnect clears the UI; and reconnect succeeds.
- A running workout keeps the screen awake, while pause/end/cancel releases Keep Awake and normal sleep resumes.
- Spoken workout instructions use the existing wording and stop/cancel when the workout lifecycle requests it.
- SISU HTTPS `/health` succeeds and a completed workout reaches `/workout/ingest` with the existing payload contract.
- With FitBaus Bike Bridge running on the LAN, Settings → Equipment accepts the bridge URL, native HTTP status/telemetry succeed, and enabling automatic resistance control during a bike workout posts absolute targets without overlapping requests.

BLE behavior cannot be fully validated in an emulator or the iOS Simulator.
