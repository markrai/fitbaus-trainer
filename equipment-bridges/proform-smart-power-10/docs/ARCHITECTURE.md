# Bike Bridge architecture

Production Bike Bridge is the Kotlin Native app under `native/`. Package
`com.fitbaus.bikebridge` (versionName from repo-root `version.js`, currently `1.0.0`) claims the ProForm Smart Power
10.0 brainboard USB, authenticates when DeviceInfo requires unlock, streams
Resistance / RPM / Watts, and serves a trusted-LAN HTTP API for FitBaus
Trainer.

Trainer remains the product. This tree is the model-specific equipment bridge.

## Modules

```text
native/
  equipment-protocol/   framing, identity, security hash, HTTP JSON contract
  bridge-app/           production Android host (USB, HTTP, pairing, Arcade)
  equipment-usb-probe/  operator-triggered read-only USB diagnostic APK
equipment-bridges/shared/arcade/   optional HUD; never owns USB or resistance
```

`equipment-protocol` is pure JVM. It must not import Android, USB, or network
types. NOTICE and STRIDE Apache-2.0 attributions ship in APK assets.

## USB session (production)

Production identity uses **AuthOnly** when DeviceInfo `requiresUnlock` is true
(Smart Power 10 `softwareVersion` 83 does):

1. DeviceInfo(MAIN=2); adopt the reply's PrimaryDevice (FitnessBike=7)
2. DeviceInfo confirm on the adopted primary
3. SystemInfo and VersionInfo on MAIN (replies addressed as device 7 are parsed)
4. One VerifySecurity on the primary; serial from DeviceInfo, part/model from
   MAIN SystemInfo, library from MAIN VersionInfo
5. MaxResistanceLevel read and periodic telemetry on the primary
6. Resistance writes (ReadWriteData command 2, field 2) only after the
   controller reports Unlocked

USB reconnect starts a new session: VerifySecurity is attempted once per
session and write readiness is not inherited from a previous connection.
AuthOnly was physically qualified on two staging cold boots (including R3).
The production APK has been verified on a warm controller (authentication
and advertised control), not as production R3 or cold-start qualification.
See [PROTOCOL.md](PROTOCOL.md).

Write-time controller status `SECURITY_BLOCK` fails closed. HTTP 200 means the
bike returned Done for that write; it is not proof the rider felt the load.
Observed resistance comes only from telemetry field 2.

Staging package `com.fitbaus.bikebridge.native` with `unlockQualification=off`
stays **WarmState**: it skips VerifySecurity. That is a diagnostic / limited
fallback, not a cold-start control path. On a cold controller it does not
reliably provide resistance writes (`SECURITY_BLOCK`). Gradle flags
`unlockQualification=auth|lockout` are staging-only experiments and cannot
be combined with `bridgeIdentity=production`.

## HTTP (trusted LAN)

Bind `0.0.0.0:8765`. Intended network is a trusted LAN only. Do not expose the
console to the public Internet.

| Method | Path | Auth | Role |
| --- | --- | --- | --- |
| GET | `/health`, `/api/v1/health` | none | listener health |
| GET | `/api/v1/status` | none | connection, control availability, requested vs observed |
| GET | `/api/v1/telemetry` | none | observed resistance / RPM / watts |
| POST | `/api/v1/resistance` | `X-Fitbaus-Token` | absolute integer 1–15 |
| POST | `/api/v1/heartrate` | `X-Fitbaus-Token` | display ingest only (30–250 BPM) |
| POST | `/api/v1/brightness` | `X-Fitbaus-Token` | Activity window percent 0–100 |
| OPTIONS | control routes | none | CORS preflight including the pairing header |

`resistanceControlAvailable` is true only when USB is connected, the session is
initialized, and the machine can set resistance. Board `maxResistanceLevel`
(observed 22 on this bike) is reported and used as the codec denominator; it
is not the HTTP acceptance window.

The surface does not expose incline, calibration, firmware, bootloader,
relative ± resistance, ramping, or raw USB.

## Pairing

Control POSTs require the console pairing token in `X-Fitbaus-Token`. The token
is an 8-character value shown grouped as `XXXX XXXX`. GET telemetry/status/health
do not require it. There is no runtime flag that can turn authentication or
unlock qualification on or off.

## Isolation

Do not run Bike Bridge and stock iFIT (`com.ifit.standalone` / `com.ifit.eru`)
at the same time. They cannot share the USB interface. Isolation is an
operator/adb step; the app does not kill, disable, or uninstall stock packages.

## Signing

Production APKs must be signed with the same certificate as the previously
installed `com.fitbaus.bikebridge` package so in-place `adb install -r` can
preserve pairing data. Keystores are not committed. See `native/local.properties`
keys `bikebridge.signing.*`.

### Process-wide USB worker ownership

Native USB worker admission is process-wide, not tied to an Android service instance. A stopped worker retains exclusive admission until its thread has actually exited, including transport cleanup. A timed-out join does not authorize a second worker or a restart of the same session. A replacement service can bind HTTP and report unavailable telemetry/control while waiting; it retries USB admission once per second until the previous worker exits. It does not retry a terminal initialization failure merely because ownership was previously blocked. Service destruction removes the retry callback. Permission results or completed open calls arriving after stop must not start protocol exchange. The shutdown join remains bounded at the existing eight seconds. The process gate is not cross-process USB arbitration with stock iFIT or the separate probe APK.

Every NativeUsbSession construction now specifies its cold-start write plan explicitly. Production still obtains AuthOnly through UnlockQualification.plan(); staging and test plans remain explicit. Pairing-token checks, resistance limits, transmit allowlists, and SECURITY_BLOCK behavior are unchanged.

Phase 0B physical acceptance: with stock iFIT out of the USB path, confirm telemetry and normal token-authorized resistance behavior, stop and restart the bridge in-process, confirm a single USB worker owns the interface and recovery occurs after release, and confirm a resistance request without the pairing token is rejected. Do not claim the stop-timeout interleaving was reproduced on physical hardware unless observed; latch-controlled JVM tests exercise that interleaving.

### Native dialog primitives (Phase 2)

The summarization provider and transcription-model dialogs share `host/ui/NativeDialogViews` for density conversion, rounded surfaces, labels, buttons, and recursive view enablement. `NativeDialogStyle` preserves their existing distinct accent colors, corners, padding, action dimensions, horizontal button weighting, and disabled-button opacity. Factories create fresh views/drawables and do not own callbacks, request admission, authorization, network work or dialog lifecycle. Each caller retains its own event guards and renders its own workflow state. Shared primitives are intentionally limited to these two similar management dialogs; field/keyboard handling, game rendering, the main activity, player controls and other unrelated view families are not migrated. No global theme or new UI framework is introduced.

JVM tests exercise the shared layout, density and opacity rules. They do not instantiate Android views. Physical API 22 visual verification: open both dialogs, confirm existing colors, spacing and scroll behavior, check the transcription model's selected/disabled appearance and horizontal job buttons, and verify the provider's keyboard, LOBO selection, test and Save gating. This is a visual-preserving extraction, not a redesign.

### Credential envelope consolidation (Phase 3)

The Audiobookshelf and Transcriber stores share `host/credentials/ConnectionCredentialEnvelope` for the existing v1 RSA-wrapped AES-128/GCM envelope. Their separate preference files, record names, RSA aliases, certificate subjects, JSON schemas, read limits (32,768 and 8,192 encrypted bytes), and persistence/locking semantics remain unchanged. The Audiobookshelf refresh compare-and-replace guard remains store-owned. The common `AndroidCredentialKeys` uses the same AndroidOpenSSL RSA provider on API 22 and earlier and the default provider afterward. Key creation is serialized within the process; connection reads do not create a missing key. Google keeps its own wrapped-key preference, v2 prefix, legacy 12/16-byte IV fallback and failure-point reporting, while sharing the RSA helper and AES-GCM implementation. No ciphertext migration, alias unification, or key rotation is performed. No credential values are logged. Existing pairing-token storage and OAuth/HTTP policy are outside this extraction.

JVM tests independently encode the previous connection format and decode newly written envelopes with the previous algorithm, exercise size limits and malformed/tampered records, and retain the Google legacy codec tests. They use standard JVM RSA and AES-GCM, not Android Keystore. Physical API 22 upgrade acceptance requires existing Audiobookshelf, Transcriber and Google records to load after installing over the current production APK, survive a process restart, and persist normal refresh/re-pair/sign-in changes without losing unrelated credentials. Do not clear app data for the upgrade check.

### Native activity decomposition (Phase 4A)

`BridgeDashboardView` owns the dashboard widget tree, its fourteen telemetry and diagnostic view references, and endpoint display state. `NativeBridgeActivity` still acquires one telemetry/HR sample per UI refresh, maps the service phase, supplies the same data to dashboard and active media HUD, controls brightness, and owns the 200 ms refresh lifecycle. The dashboard receives values only: it does not acquire a service, start or stop USB, issue resistance commands, own a timer, or alter media/game lifecycles. `DashboardEndpointState` preserves address lookup every ten refreshes, forced lookup on resume, and immediate bind-error presentation. The existing caption/palette contract now checks the extracted view. JVM tests cover endpoint refresh and error behavior; existing mapper tests cover telemetry and diagnostics. Physical API 22 checks: compare dashboard layout and colors with the prior build, verify live/stale metrics and HR, diagnostics and endpoint, navigate among dashboard/games/media, and resume from Settings. No feature or protocol changes intended. Phase 4A is a bounded first extraction, not the full activity decomposition; subsequent slices should address distinct ownership boundaries separately.

### Native navigation header extraction (Phase 4B)

`BridgeNavigationHeader` owns the existing brand/version row, scrollable dashboard/game/media tab groups, fixed settings gear, tab view references and selected-tab appearance. It receives three callbacks from `NativeBridgeActivity`: select a mode, open settings, and open a game's tracker picker. It does not own selected mode or call the service, USB, camera or players. `ArcadeModeController` remains authoritative for mode transitions; the activity renders the selected mode into the header after showing content. The activity still owns the settings launch with the current game context, and audiobook fullscreen continues to hide the same header view and change root padding. Existing layout, touch dimensions, captions, accessibility label, long-press behavior and tab order remain unchanged by design. Existing source layout/wiring checks follow the extracted owner; behavioral mode-controller tests are unchanged. Physical API 22 checks: compare header and horizontal scrolling, verify settings gear and FITBAUS long-press, game-only tracker picker, selected tab after media restore, and hiding/restoring the header in audiobook fullscreen. No new dependencies or lifecycle-policy changes.

### Arcade configuration ownership (Phase 4C)

`ArcadeConfiguration` owns existing per-game tracker preference keys, preset families and shared diagnostics overlay preference. The Android adapter still uses the private `arcade_dev` preferences and asynchronous `apply()`; no migration or new defaults. Bricks uses the shared tracker default (currently Face), Math uses Fingers, and the four face games use their independent Face presets. `ArcadeTrackerPicker` owns the existing developer menus, game-specific option dispatch and callback wiring; non-game modes do not open it. `ArcadeContent.applyDiagnosticsOverlay` projects one overlay setting to all six game views. The activity remains responsible for applying active tracker changes, resetting diagnostics and restarting the current camera only when the game is active and its settings actually change. Game option persistence, control routing, mode transitions, USB, media and camera ownership otherwise remain unchanged. The arcade source allowlist still checks every file for equipment control references. JVM behavioral tests replace tracker preference source-string checks, preserving the remaining lifecycle/read-only assertions. Physical API 22 checks: long-press each game tab, confirm existing preset and options, change a non-active game's settings without restarting the active camera, change the active game's tracker and verify recovery, toggle overlay and restart the app to confirm persistence.

### Arcade lifecycle extraction (Phase 4D)

`ArcadeLifecycle` owns the ordered game activation, deactivation and tracker-change application policy. `AndroidArcadeLifecycleEffects` delegates to the existing camera session, clock, controller, motion monitor and game views; the activity supplies its existing diagnostics reset. The mode controller remains the sole selected-mode/active-state owner. No second mode flag or worker is introduced. Activation still resets diagnostics and motion, refreshes and resets input, loads saved tracker settings, enables wave gestures only for Biketris, then starts camera before clock. Deactivation still resets transient input, stops the clock and camera with the original reason, and pauses Trails, It Hears You and Biketris. Changing an inactive game's tracker persists it without touching the active camera; changing the selected active game's tracker restarts only that camera when settings differ. Android lifecycle callbacks, media PiP, permission handling, controller event routing, arcade rendering, UVC ownership and USB service lifecycle remain in the activity. Six JVM tests exercise actual lifecycle sequencing with recording effects, including integration with ArcadeModeController. The read-only arcade source boundary scans the new file as well. Physical API 22 verification: switch between games and media, verify camera and wave behavior, change active and inactive tracker settings, pause/resume/exit, confirm telemetry and resistance authorization are unaffected. Media lifecycle is a separate bounded follow-up (Phase 4E), not part of this change.
