# UVC physical acceptance (safe procedure)

Do **not** run this procedure until code review of the current working tree is complete.
This document is preparation only; this pass does not install or deploy.

## Package identities

| Identity | `bridgeIdentity` | `applicationId` | Typical APK |
|---|---|---|---|
| Staging (default) | `staging` (or unset) | `com.fitbaus.bikebridge.native` | `bridge-app-debug.apk` |
| Production | `production` | `com.fitbaus.bikebridge` | production-signed APK |

`NativeBridgeActivity.startBridgeService()` always starts **this app’s** `NativeBridgeService`, which claims the bike USB controller.

Installing staging **alongside** production yields **two packages**. If both services run, they can compete for `8508:2` / `213c:0002`. That is **not** automatically safe.

## Recommended safe path (staging sidecar)

Goal: exercise C270 UVC + arcade without replacing production signing/data.

1. **Baseline (production still installed)**
   - `adb shell dumpsys package com.fitbaus.bikebridge | grep -E versionName|versionCode|signatures`
   - `adb shell ps | grep fitbaus`
   - `adb shell dumpsys usb` — note bike preference `8508:2 → com.fitbaus.bikebridge`
   - Record a telemetry snapshot / resistance reading from the live Bridge UI
2. **Stop production Bridge so it cannot race USB**
   - `adb shell am force-stop com.fitbaus.bikebridge`
   - Confirm `ps` shows no `com.fitbaus.bikebridge`
3. **Install staging only**
   - Build: default `bridgeIdentity=staging` → `com.fitbaus.bikebridge.native`
   - `adb install -r bridge-app/build/outputs/apk/debug/bridge-app-debug.apk`
   - Do **not** use `bridgeIdentity=production` unless you intentionally replace the production app with a production-signed build
4. **Run staging Bridge**
   - Launch `com.fitbaus.bikebridge.native`
   - Confirm bike USB preference / session binds to the **staging** package only
   - Confirm production remains force-stopped
5. **UVC checks (no resistance writes from Trainer)**
   - Enter an arcade game with C270 attached
   - First enter may prompt USB permission then use Camera1; leave and re-enter after grant for UVC
   - Capture logcat: `FitbausUvcHost`, `FitbausUvc`, `FitbausExtCam`
   - Confirm frames / tracking; move in front of C270
   - Exit game; confirm cleanup (no crash; worker continues)
   - Unplug C270; re-enter → Camera1; replug → denial sticky reset then prompt/grant path
6. **Rollback**
   - `adb uninstall com.fitbaus.bikebridge.native`
   - `adb shell am start -n com.fitbaus.bikebridge/.host.NativeBridgeActivity` (or the production launcher)
   - Verify production Bridge reconnects, USB preference restored, telemetry/resistance path healthy
   - Do not change resistance during acceptance unless that is an explicit separate test

## Unsafe / avoid

- Running staging and production Bridge services at the same time
- Sideloading a **debug-signed** APK onto `com.fitbaus.bikebridge` (signature mismatch / data loss risk)
- Assuming `adb install -r` of staging replaces production (it does not; different applicationId)
- Hot-plug mid-game switching expectations (not implemented)

## Production-identity acceptance (optional, higher risk)

Only with production keystore (`bikebridge.signing.*`) and `bridgeIdentity=production`:

- Replaces `com.fitbaus.bikebridge` in place; preserves data only if signing matches
- Keep a known-good production APK for rollback
- Still force-stop before/after swaps; verify USB prefs and telemetry after rollback

## Evidence to capture

- USB permission grant/deny log lines and `UsbManager.hasPermission` outcome
- First-frame / tracking diagnostics from arcade HUD
- Detach/reattach behavior
- Bike controller still exclusively owned by the active Bridge package
- No unintended resistance changes

## Separate distribution gate

Static libusb LGPL relink materials remain a **release** blocker (`equipment-bridges/shared/arcade/RELEASE-BLOCKERS.md`), not part of physical camera acceptance.
