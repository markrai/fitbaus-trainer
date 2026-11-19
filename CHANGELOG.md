# Changelog

All notable changes to FitBaus are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version
numbers follow [VERSIONING.md](VERSIONING.md).

FitBaus Full is developed on `main`. FitBaus Lite, a compact edition for
storage-constrained ProForm Smart Power 10.0 consoles without external webcam
support, is maintained on `lite/1.x`.

## [Unreleased]

FitBaus Full 2.1.3 (`versionCode 20103`) is in development on `main`.
Full 2.1.1 was prepared but not published; its YouTube improvements remain
included in this upcoming release.

### Added

- **Local Google OAuth JSON import for Bike Bridge.** A root-level
  `push_youtube_auth.bat` detects a Google TV client JSON file in a
  Git-ignored `secrets/youtube/` directory, transfers it over ADB, and
  triggers encrypted credential storage and the existing Google device-code
  flow. Temporary files are cleaned up without exposing the secret in shell
  arguments, APKs, logs or Bridge APIs.
- **Google account connection and account-first discovery for Bike Bridge
  YouTube.** Authorize a Google account from a phone using Google's
  limited-input device OAuth flow. Browse your subscriptions, recent channel
  uploads, and personal playlists with pagination, and open videos in the
  existing native player. When connected, MY YOUTUBE takes the place of
  random Trending videos as the default view while Search and Trending remain
  available. Credentials and refresh tokens are protected by Android
  Keystore; sign-out clears local authorization and requests revocation.
  Google's personalized Home recommendations are not available through the
  official YouTube Data API.
- **YouTube captions on the Bike Bridge.** Available subtitles appear over
  the video with a CC toggle. The player prefers English and human-authored
  captions when available and supports WebVTT, TTML, and SRT. Caption loading
  is bounded and failures are nonfatal to video playback.

### Changed

- **YouTube play/pause feedback.** Tapping a video or its playback control
  briefly shows a centered play or pause icon.
- **YouTube search clear.** An × inside the search field clears entered text
  without submitting a new search.

### Fixed

- **Android 5.1 Google OAuth credential round-trip.** Select the legacy
  AndroidOpenSSL RSA provider on API 22 and earlier for Keystore-backed
  AES-key wrapping/unwrapping, verify encrypted credentials can be reloaded
  before displaying a Google device code, and use an explicit AES-GCM nonce.
  Preserve existing Keystore aliases and support old encrypted payloads.
  Fail safely with a specific crypto stage when verification fails, without
  clearing pairing or other Bridge settings.
- **Google device authorization diagnostics.** If the first OAuth token poll
  fails, the bike now distinguishes Google's HTTP status and known OAuth
  error (for example `invalid_client (HTTP 401)`) from malformed responses,
  local encrypted-credential failures, and network/TLS errors. Normal
  `authorization_pending` and `slow_down` responses still continue
  polling. No client credentials, device codes, tokens or untrusted Google
  error descriptions are displayed.

## [2.1.0] - 2026-11-16

Published on GitHub as **FitBaus Full 2.1.0**, with the native YouTube
player, BIKETRIS, and external USB webcam support on the bike console.

### Added

- **YouTube tab in the Bike Bridge.** Browse trending videos, search YouTube
  and play public videos inside the console app, with pause, seeking and
  resume from the last position. A maximum quality setting (240p, 360p or
  480p; 360p by default) is never exceeded. The player is released whenever
  you leave the tab or the app pauses, and the tab never starts the arcade
  camera or touches the Bike Bridge's equipment connection or resistance
  control.
- **YouTube player brightness and volume controls.** A brightness slider below
  the video adjusts the console screen through the Bike Bridge's existing
  brightness setting, and a vertical slider beside the video sets the music
  volume (loudest at the top).
- **BIKETRIS arcade game.** A falling-block puzzle steered by moving your head
  left and right; a deliberate sideways hand wave rotates the piece. Dragging
  across the board moves pieces when face tracking is unavailable.
- **Cadence-controlled BIKETRIS speed.** Choose on screen between PEDAL TO SLOW
  (the default; pedaling faster gives you more time) and PEDAL TO SPEED UP
  (pedaling faster makes pieces fall faster). Without live cadence, pieces
  fall at the standard speed.
- **External webcam support.** Arcade games can use an external USB (UVC)
  webcam, and a new External Webcams settings tab shows a live preview with
  zoom controls and remembers settings for each camera.
- **Bike Bridge header settings gear and version label.** The gear opens
  settings with one tap, and the installed version is shown beside the
  FITBAUS title. Also released in Lite 1.0.1.
- **Release workflow.** Signed Trainer and production Bike Bridge artifacts
  are built from an existing tag, verified, and published with SHA-256
  checksums. See [docs/RELEASE.md](docs/RELEASE.md).

### Changed

- Arcade game tabs scroll horizontally, so the settings gear stays visible as
  tabs are added.
- `deploy-bike.bat` refuses to install a Bike Bridge build with a lower
  version code or a different signing certificate, and never uninstalls the
  console app, so pairing is preserved.

### Fixed

- The Bike Bridge HTTP server can bind its port again immediately after the
  service restarts. Also released in Lite 1.0.1.

## [1.0.1] - 2026-11-14

Published on GitHub as **FitBaus Lite 1.0.1** from `lite/1.x`, with a signed
Trainer Android APK, a signed Lite production Bike Bridge APK, the web/PWA
bundle, and SHA-256 checksums.

### Added

- **Bike Bridge settings gear.** A gear in the upper-right header opens the
  pairing and settings screen with one tap; long-pressing FITBAUS still works.
- **Bike Bridge version label.** The installed version (for example `v1.0.1`)
  is shown beside the FITBAUS title.

### Fixed

- The Bike Bridge HTTP server can bind its port again immediately after the
  service restarts, instead of failing while the previous socket is closing.

## [1.0.0] - 2026-11-12

First unified FitBaus version: the Trainer web/PWA, Capacitor Android and iOS
apps, Native Bike Bridge and the arcade games inside the Bridge all report
**1.0.0**. The `v1.0.0` tag exists, but its GitHub release was not published.
Platforms: the hosted PWA, Capacitor Android (minimum API 24), Capacitor iOS
(source and Xcode project), and the Native Bike Bridge for the ProForm Smart
Power 10.0 (Android 5.1.1). Historical `0.x` entries below are development
records and are not renumbered.

### Added

- A single authoritative product version in `version.js`, with Node and Gradle
  helpers that reject missing, malformed or out-of-range versions.
- A version-consistency check (`npm run check:version`) in CI, including the
  Bike Bridge's Gradle-resolved metadata.
- Shared web deploy packaging used by `build-deploy.bat` and the release
  artifact zip.
- A manual **Release artifacts** workflow that packages inspection artifacts
  with SHA-256 checksums without tagging or publishing.

### Changed

- **Unified versioning.** Android `versionName`, iOS `MARKETING_VERSION`, Bike
  Bridge `versionName` and the HTTP `bridgeVersion` all derive from
  `version.js`. Numeric codes use `major * 10000 + minor * 100 + patch`
  (`1.0.0` is `10000`).
- **PWA cache identity.** The service worker cache is named after the release
  (`fitbaus-trainer-1.0.0`). Saved workouts and athlete data are unchanged.
- Upgrades keep existing package and bundle IDs, so local workout history,
  profiles, pairing and equipment settings are preserved.

### Removed

- The retired Xamarin/C# Bike Bridge host, its build scaffolding and migration
  scripts. CI now validates the Native Bike Bridge with Gradle unit tests.

## [0.10.14] - 2026-11-10

### Changed

- **Automatic workout resistance is standard.** Removed the Settings → Equipment
  "Automatic resistance control" toggle and the "Leave automatic resistance off"
  instruction. An authorized, active, unpaused structured bike workout now sends
  its recommended resistance to the Native Bike Bridge without an opt-in. A legacy
  persisted `automaticControlEnabled: false` is ignored and dropped on the next
  save; URL, pairing code and console brightness are preserved. Session binding,
  Freestyle policy, pause, disarm, control availability and pairing still gate
  every command.
- **Equipment diagnostics** now show recommended, commanded, Bridge-accepted and
  physically observed resistance separately, plus session authorization, last
  command outcome and a status line (for example "Bridge accepted R3 - awaiting
  physical confirmation" or "Pairing required").
- **Native Bike Bridge cold-start unlock targeting.** Authentication now matches
  the working Legacy console: DeviceInfo(MAIN) still adopts and confirms
  PrimaryDevice (FitnessBike=7); SystemInfo and VersionInfo are collected on
  MAIN; VerifySecurity and resistance writes stay on the bike. The unlock hash
  uses MAIN part/model/library with the DeviceInfo serial, not a second identity
  read from device 7. MAIN SystemInfo/VersionInfo replies that come back
  addressed as FitnessBike=7 are parsed the same way DeviceInfo bootstrap
  already adopts device 7.
- **Production Native initialization authenticates when required.** After two
  independent Native-only cold boots on this Smart Power 10 (controller
  Unlocked, HTTP 200, fresh observed R3, operator-confirmed load), production
  identity uses the qualified AuthOnly sequence as normal startup. Staging
  `unlockQualification=off` remains WarmState for rollback. USB reconnect
  re-authenticates once per new USB session and does not inherit write
  readiness. Production Gradle rejects staging `auth`/`lockout` flags.

### Fixed

- A workout recommendation that arrived before the first successful Bridge status
  poll was never sent until the recommendation changed. It is now sent once when
  control becomes available.
- **Native Bike Bridge qualification evidence.** Production Gradle configuration
  rejects `unlockQualification=auth`/`lockout`. Qualification inspects the exact
  APK's dex identity (not a filename or `BuildConfig.java`), scopes
  authentication logs to the current cold-start session, and requires a
  resistance observation newer than the command. HTTP 200 plus a previously
  existing R3 reading is not a pass. Staging AuthOnly builds remain isolated
  from production.

## [0.10.13] - 2026-10-05

### Changed

- **Bike Bridge metric colors.** Machine-guidance and Bike Bridge status RPM,
  resistance, and watts values now use the same colors as FitBaus Bike Bridge:
  magenta (`#FF00FF`) for RPM, orange (`#FF8C00`) for resistance, and blue
  (`#0096FF`) for watts, when a live measurement is present.

## [0.10.12] - 2026-08-31

### Added

- **VO2 submax estimator.** The standalone VO2 Max Estimation workout now
  evaluates protocol evidence at finalization and persists a local
  `vo2_assessment` (`bike-submax-linear-hr-workload` / version 1). Estimator v1
  consumes only `bike-submax-70rpm` / version 1, requires an explicit saved
  age and weight, and uses performed workload (`measured_watts` or cadence-
  verified calibration) plus a 110 bpm / <85% predicted-HRmax envelope.
  Regression R² is stored as `fit_quality`, not overall confidence.
  `limit_reached` is a distinct protocol termination from cancel / Early
  Cooldown. Historical assessments snapshot inputs and workload provenance so
  later profile edits do not rewrite them. Assessment and evidence remain
  stripped from SISU ingest. New VO2 runtime modules are included in the PWA
  precache list.

## [0.10.11] - 2026-08-28

### Added

- **Standalone VO2 test protocol added.** Workout selector includes
  `VO2 Max Estimation`, a versioned SISU Bike Submax Protocol v1
  (`bike-submax-70rpm` / version 1). The test records protocol evidence on
  local `vo2_evidence.protocol`. Protocol-v1 workloads resolve only within
  commandable resistance 1–10 so current automatic Bike Bridge transport
  cannot silently rewrite a prescribed stage. Machine calibration remains
  1–15. This version records protocol evidence only; the estimate itself was
  added in 0.10.12. See `VO2-TEST-PROTOCOL-V1.md`.

## [0.10.10] - 2026-08-28

### Added

- **VO2 evidence foundation** - Completed workouts can persist local
  `vo2_evidence`: pause-safe active duration, phase boundaries, work-end /
  cooldown markers (including Early Cooldown), HR acquisition facts, and
  machine provenance. Evidence only; no VO2 calculation, workout, or UI.
  Historical workouts without evidence remain unchanged. Evidence is stripped
  from SISU server ingest. See `VO2-EVIDENCE-FOUNDATION.md`.

## [0.10.9] - 2026-08-28

### Added

- **FitBaus Bike Bridge client** - Settings -> Equipment can store a LAN bridge
  URL and optional automatic resistance control. Native Capacitor HTTP polls
  `/api/v1/status` and `/api/v1/telemetry` once per second and posts absolute
  `/api/v1/resistance` targets from existing machine guidance. Observed bike
  resistance, RPM, and watts stay independent of requested/desired values.

### Fixed

- **Bike bridge resistance range** - ProForm physical levels 1-15 are posted
  unchanged. The client no longer clamps 11-15 down to 10. Android cleartext
  documentation no longer claims Network Security Config is limited to the
  FitBaus host; SISU ingest remains HTTPS-only in application code.

## [0.10.8] - 2026-08-27

### Added

- **Controller decision audit** - Local workout summaries can include a bounded
  `machine_decision_audit` of work-phase scheduling, HOLD/increase/decrease
  evaluations, and insufficient-HR deferrals without changing live guidance.

### Fixed

- **In-workout portrait height** - Pause, phase, machine card, and ring no
  longer push the heart and machine icons below the viewport on short phones.
  Leftover portrait height is distributed between those blocks so the stack is
  not packed at the top on taller phones. The ring sits above the heart and
  activity icons instead of overlapping them. The gray workout card fills the
  phone height and sits just above the warm-up / workout duration line. The
  start / pause row sits halfway between the day dropdown and the phase bar.

## [0.10.7] - 2026-08-27

### Added

- **Machine diagnostics export** - Settings -> Equipment can export an on-device
  machine-learning diagnostics snapshot, including timing evidence without
  inventing concrete evaluation times from phase duration alone.

### Fixed

- **Workout JSON download** - Download JSON from the workout list and summary
  modal uses in-memory summary data so the browser keeps the user gesture.
- **Modal overlay stacking** - Dialog overlays use a higher z-index so they sit
  above the hamburger / chrome UI.
- **Native system bars** - System bars stay hidden after app resume on native
  builds.

## [0.10.6] - 2026-08-26

### Added

- **Shadow resistance prediction** - Shadow-only resistance / HR predictions for
  machine guidance (no live resistance control changes).
- **Shadow prediction validation** - High-confidence validation of frozen ±1
  shadow predictions with a processed-session ledger.

### Fixed

- **Shadow HR levels** - Shadow HR estimates use effective / achievable
  resistance levels for hypothetical steps.

## [0.10.5] - 2026-08-26

### Added

- **HR response reliability** - Track observable response windows versus
  detected onsets (lifetime and recent bounded opportunity history).
- **Trusted earlier timing** - Medium / long evaluation waits may shorten when
  recent high-confidence opportunity history allows; short-interval timing
  defaults are unchanged.

## [0.10.4] - 2026-08-26

### Added

- **Machine HR dynamics learning** - Learn heart-rate response delay and delta
  after work starts and after ±1 resistance steps.
- **Personalized evaluation timing** - Medium / long evaluation waits use
  trusted delay medians from learned dynamics.

## [0.10.3] - 2026-08-26

### Added

- **Learned starting resistance** - Learn starting resistance per
  machine / activity / intent / duration class from qualifying completed
  sessions.

### Fixed

- **Late-work HR gate** - Learned starts train only when late-work HR is within
  target (±3 bpm).

## [0.10.2] - 2026-08-26

### Added

- **Machine-aware workout guidance** - Resistance / cadence guidance semantics
  for profiled machines (rolling-median HR gates, short-interval finalize,
  recovery cadence at 63 RPM).
- **Runtime activity selection** - Choose workout activity at start when a plan
  allows more than one.

### Changed

- **Short-interval adaptation** - Evaluate only with usable HR near the end of
  the repetition; finalize next-rep adaptation at the work-phase boundary when
  the last in-phase tick is missed.

## [0.10.1] - 2026-08-25

### Added

- **Machine profiling** - Equipment profiles and ProForm SMART Power 10
  resistance / cadence guidance with equipment selection and voice prompts.
- **Short-interval adaptation** - Adapt short-interval reps from evaluable HR
  near the end of the work phase.

## [0.10.0] - 2026-08-25

### Added

- **Capacitor 8 native apps** - Android and iOS shells with community plugins
  for Bluetooth LE, Keep Awake, and text-to-speech. Native builds use
  `CapacitorHttp` for SISU `/health` and `/workout/ingest`; the hosted PWA path
  (Web Bluetooth, browser speech, Screen Wake Lock, service worker) is
  unchanged. See [NATIVE-DEVELOPMENT.md](NATIVE-DEVELOPMENT.md).

## [0.9.41] - 2026-02-22

> Formerly labeled `APP_VERSION` **0.9.9** after the post-0.9.34 reset.

### Added

- **Open Graph / social meta** - Share-oriented meta tags for the hosted app.
- **Facebook share interstitial** - Interstitial UI for Facebook sharing.

## [0.9.40] - 2026-02-19

> Formerly labeled `APP_VERSION` **0.9.8** after the post-0.9.34 reset.

### Changed

- **Release readiness** - Manifest, service worker, and packaging polish ahead
  of release.

## [0.9.39] - 2026-02-17

> Formerly labeled `APP_VERSION` **0.9.7** after the post-0.9.34 reset.

### Added

- **Downregulation graph** - Heart-rate graph visualization for downregulation
  sessions.

### Changed

- **Custom HR target visibility** - Custom downregulation HR target is shown
  only in the noise visualization.

## [0.9.38] - 2026-02-17

> Formerly labeled `APP_VERSION` **0.9.6** after the post-0.9.34 reset.

### Added

- **Whale & none visualizations** - Additional downregulation visualization
  options.

## [0.9.37] - 2026-02-17

> Formerly labeled `APP_VERSION` **0.9.4** after the post-0.9.34 reset.

### Changed

- **Downregulation play control** - Play button available for all
  downregulation visualizations.

## [0.9.36] - 2026-02-17

> Formerly labeled `APP_VERSION` **0.9.2** after the post-0.9.34 reset.

### Changed

- **Downregulation viz polish** - Improvements across downregulation
  visualizations.

## [0.9.35] - 2026-02-14

> Formerly labeled `APP_VERSION` **0.9.1** after an accidental reset from
> **0.9.34**.

### Changed

- **Noise visualization** - Downregulation noise viz enhancements.

## [0.9.34] - 2026-02-14

### Changed

- **Goo credits** - Credit attribution for the Goo downregulation animation.

## [0.9.33] - 2026-02-14

### Added

- **HR-controlled dots** - Downregulation dots driven by heart rate.
- **Goo visualization** - Goo animation option, constrained so it cannot drift
  too far off the bottom of the screen.
- **Starfield restored** - Starfield available again as a second downregulation
  option.

## [0.9.30] - 2026-02-13

### Fixed

- **Downregulation play after summary** - Play button reappears after the
  downregulation summary.

## [0.9.27] - 2026-02-13

### Fixed

- **Battery + HR on mobile** - Chest-strap battery polling and HR monitoring no
  longer conflict on mobile.

## [0.9.26] - 2026-02-13

### Changed

- **Version bump** - Patch release marker (no separate feature commit).

## [0.9.25] - 2026-02-13

### Fixed

- **Mobile HR display** - Heart rate shows correctly on mobile again.

## [0.9.22] - 2026-02-13

### Added

- **NAS auto-deploy** - Development deploy path to NAS.

## [0.9.21] - 2026-02-12

### Changed

- **Faster starfield** - Increased downregulation starfield speed.
- **Downregulation SISU sync** - Downregulation sessions can sync with SISU.

## [0.9.20] - 2026-02-12

### Changed

- **Downregulation performance** - Optimizations for downregulation rendering
  and session handling.

## [0.9.17] - 2026-02-11

### Changed

- **Live HR only** - Removed simulated HR from downregulation.
- **Starfield + HR** - Fundamental starfield movement change synchronized with
  heart rate.

## [0.9.16] - 2026-02-11

### Added

- **Downregulation mode** - Guided downregulation sessions with orb viz and
  current HR in the bottom-left.

### Fixed

- **Stop downregulation** - Correct teardown when stopping a downregulation
  session.
- **Strap disconnect** - Clear HR when the chest strap disconnects.

## [0.9.15] - 2026-02-11

### Changed

- **Architectural modularization** - Phases 1–3 of the TypeScript module
  refactor, including splitting `updateDisplay`.

### Fixed

- **Strap battery indicator** - Re-implement indicator, remove extra dot, and
  poll battery level.
- **HR animation fidget** - Stabilize the heart fidget animation.

## [0.9.14] - 2026-02-11

### Added

- **Battery indicator UI** - Chest-strap battery level indicator.

## [0.9.12] - 2026-02-11

### Added

- **HR strap connection indicator** - Visual connection state for the chest
  strap.
- **Strap battery level** - Show chest-strap battery level.

## [0.9.11] - 2026-02-10

### Added

- **Deploy script + folder** - Dedicated deploy path for releases.
- **Single-source version sync** - `version.js` is the source of truth; sync
  script updates `src/version.ts` and `package.json`.

## [0.9.9] - 2026-01-28

### Added

- **TypeScript migration** - App source moved to TypeScript with `package.json`
  tooling.
- **Cancelled workouts** - Explicit cancelled-workout concept in session data.
- **Ring elapsed / remaining toggle** - Toggle total remaining versus total
  elapsed on the progress ring.

### Changed

- **Decrementing ring** - Ring decrements by default with phase-appropriate
  colors.
- **Pre-workout HR on white heart** - HR value uses black text on the white
  heart before a workout starts.
- **SISU port placeholder** - Default / placeholder port updated to 443.

### Fixed

- **`updateDisplay` safety** - Try/catch around `updateDisplay()`.
- **Low BPM heart color** - Heart turns yellow when BPM is too low.

## [0.9.8] - 2026-01-28

### Changed

- **Workouts tab swipe colors** - Swapped swipe action colors on the workouts
  tab.

## [0.9.7] - 2026-01-28

### Added

- **Workout dropdown + pause** - Dropdown for workouts and a pause control.

### Fixed

- **Promise error** - Fix promise handling error in UI flow.

## [0.9.6] - 2026-01-28

### Fixed

- **Heart pulsating** - Correct heart pulse animation.
- **No-HR heart color** - Heart icon is white when no HR is detected.

## [0.9.5] - 2026-01-28

### Changed

- **Already installed** - Clearer indication when the PWA is already installed.

## [0.8.5] - 2026-01-20

### Added

- **Preferences tab** - Preferences UI, including optional seconds display in
  total workout time.

### Fixed

- **SISU host URL cleanup** - `cleanHostForUrl` and removal of a stray colon
  before the port.
- **Stale sessions** - Prevent sessions longer than 24 hours.
- **Day workout summary** - Remove today fallback; respect the day workout
  summary.

### Changed

- **Summary wording** - Rename “sustain” to “workout” in the summary block.

## [0.8.4] - 2026-01-14

### Added

- **Delete confirmation** - Confirmation dialog before deleting workout data.
- **SISU workout sync** - Sync completed workouts to SISU.
- **HTTPS for SISU** - Enforce HTTPS when connecting to SISU.

### Fixed

- **HR range heart color** - Heart color honors the configured BPM range.
- **VO2 interval countdown** - VO2 interval phases show the correct phase
  countdown instead of a sustain countdown.

### Changed

- **Zone 2 long machine** - Zone 2 long machine workouts are explicitly
  elliptical.

## [0.8.3] - 2026-01-14

### Changed

- **Version bump** - Patch release marker (no separate feature commit).

## [0.8.2] - 2026-01-14

### Added

- **Swipe to delete** - Swipe gesture to delete workout data.

## [0.8.1] - 2026-01-12

### Added

- **Variant days** - Variant-day workout capability.
- **SISU-aligned intents** - Intents aligned with SISU values (not opaque IDs).

### Fixed

- **Cardio range wrapping** - No-wrap on cardio range labels.

## [0.8.0] - 2026-01-12

### Added

- **Centralized versioning** - `version.js` as the app version source with an
  auto-updating service worker.

### Fixed

- **New-version popup loop** - Stop infinite “new version available” popup
  loops.

## [0.0.5] - 2026-01-12

### Changed

- **BPM layout** - BPM and BPM range aligned with the heart.

## [0.0.4] - 2026-01-11

### Added

- **PWA support** - Installable progressive web app (initial pass).
- **Workout JSON export** - Export JSON at end of workout.
- **Logo + data JSON** - Branding logo and corrected workout JSON.

### Changed

- **Mobile aesthetics** - Mobile layout polish.

## [0.0.3] - 2026-01-09

### Added

- **BLE / ANT+ HR** - Rudimentary chest-strap heart-rate capability.

### Changed

- **Sizing consistency** - More consistent control and layout sizing.

## [0.0.2] - 2025-12-12

### Changed

- **4×4 grid + emojis** - Expanded workout grid presentation.

## [0.0.1] - 2025-12-11

### Added

- **Initial trainer** - First workout trainer UI with profile, workout data,
  workout logic, and basic controls.

[Unreleased]: https://github.com/markrai/fitbaus-trainer/compare/v1.0.0...HEAD
[1.0.1]: https://github.com/markrai/fitbaus-trainer/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/markrai/fitbaus-trainer/tree/v1.0.0
